import {open, type DB} from '@op-engineering/op-sqlite';

/**
 * Local SQLite history for Telegraph download batches.
 *
 * Design follows AGENTS.md §4 (multi-version upgrade compatibility):
 *   - Schema version is persisted in SQLite's native `PRAGMA user_version`
 *     (a durable integer), plus a human-readable `schema_meta` table.
 *   - Migrations are applied in strict version order (v1 -> v2 -> ...). Each
 *     migration only handles the delta from the previous version, so a user
 *     upgrading from any old version (v1, v3, ...) runs every not-yet-applied
 *     migration in sequence until reaching the latest.
 *   - Each migration runs inside a transaction; on failure it rolls back so a
 *     half-applied schema never lands.
 *   - New tables / columns use DEFAULTs rather than bare NOT NULL so old rows
 *     keep working after ALTER TABLE.
 *
 * Times are stored as UTC milliseconds (AGENTS.md §6); the UI is responsible
 * for converting to the device's local timezone before display.
 */

export interface HistoryRecord {
  id: number;
  url: string;
  title: string;
  imageCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  saveDir: string;
  status: HistoryStatus;
  /** UTC milliseconds. */
  createdAt: number;
  /** UTC milliseconds. */
  updatedAt: number;
}

export type HistoryStatus = 'done' | 'partial' | 'failed' | 'cancelled';

export interface UpsertHistoryInput {
  url: string;
  title: string;
  imageCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  saveDir: string;
  status: HistoryStatus;
}

export interface HistoryRow {
  url: string;
  title: string;
  imageCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  saveDir: string;
  status: HistoryStatus;
}

/** A migration step: brings the schema from `version - 1` to `version`. */
interface Migration {
  version: number;
  description: string;
  /**
   * Applies the DDL for this step. Runs inside a transaction, so it must use
   * the async `execute` API (op-sqlite transactions expose `execute` only).
   */
  up: (db: DB) => Promise<void>;
}

export const LATEST_SCHEMA_VERSION = 1;

/**
 * Migration manifest (AGENTS.md §4). Add a new entry here for every future
 * schema change and NEVER edit a previous step in place.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: history table + schema_meta table',
    up: async db => {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );`,
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          image_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          save_dir TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'done',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(url)
        );`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_history_created_at
         ON history(created_at DESC);`,
      );
    },
  },
];

/** Single in-process connection, lazily opened and migrated once. */
let db: DB | null = null;
let initPromise: Promise<void> | null = null;

export function getDatabaseName(): string {
  return 'tgdownloader.sqlite';
}

/**
 * Open (and migrate) the database. Safe to call multiple times; only the
 * first call performs the work, subsequent calls await the same promise.
 */
export function initHistoryDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  db = open({name: getDatabaseName()});
  await runMigrations(db);
}

export function getDb(): DB {
  if (!db) {
    throw new Error('history database not initialised; call initHistoryDatabase() first');
  }
  return db;
}

/**
 * Apply all pending migrations in order, each inside its own transaction.
 * Uses PRAGMA user_version as the source of truth for the current schema
 * version so old users upgrade incrementally (AGENTS.md §4).
 */
export async function runMigrations(database: DB): Promise<void> {
  let current = getSchemaVersion(database);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // Each migration is atomic: apply DDL + version bump inside a transaction.
    await database.transaction(async tx => {
      await migration.up(tx as unknown as DB);
      await setSchemaVersion(tx as unknown as DB, migration.version);
      await tx.execute(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
        ['last_migration_version', String(migration.version)],
      );
      await tx.execute(
        'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
        ['last_migration_desc', migration.description],
      );
    });
    current = migration.version;
  }
}

function getSchemaVersion(database: DB): number {
  const res = database.executeSync('PRAGMA user_version;');
  const v = res.rows?.[0]?.user_version;
  return typeof v === 'number' ? v : 0;
}

async function setSchemaVersion(database: DB, version: number): Promise<void> {
  await database.execute(`PRAGMA user_version = ${version};`);
}

export function getLatestSchemaVersion(): number {
  return LATEST_SCHEMA_VERSION;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Insert or update a history row for a given URL (one row per Telegraph page).
 * On conflict, the counters and status are overwritten with the latest run.
 */
export async function upsertHistory(input: UpsertHistoryInput): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  const now = Date.now();
  await d.execute(
    `INSERT INTO history
       (url, title, image_count, success_count, failed_count, skipped_count,
        save_dir, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       image_count = excluded.image_count,
       success_count = excluded.success_count,
       failed_count = excluded.failed_count,
       skipped_count = excluded.skipped_count,
       save_dir = excluded.save_dir,
       status = excluded.status,
       updated_at = excluded.updated_at;`,
    [
      input.url,
      input.title,
      input.imageCount,
      input.successCount,
      input.failedCount,
      input.skippedCount,
      input.saveDir,
      input.status,
      now,
      now,
    ],
  );
}

/** List most recent records, newest first. */
export async function listHistory(limit = 100): Promise<HistoryRecord[]> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT id, url, title, image_count, success_count, failed_count,
            skipped_count, save_dir, status, created_at, updated_at
     FROM history
     ORDER BY created_at DESC
     LIMIT ?;`,
    [limit],
  );
  return (res.rows ?? []).map(rowToRecord);
}

/** Delete a single history row (does NOT touch downloaded files). */
export async function removeHistory(id: number): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute('DELETE FROM history WHERE id = ?;', [id]);
}

/** Clear all history (does NOT touch downloaded files). */
export async function clearHistory(): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute('DELETE FROM history;');
}

/** Close the database (used for tests / teardown). */
export async function closeHistoryDatabase(): Promise<void> {
  if (db) {
    try {
      await db.close();
    } catch {
      // ignore
    }
  }
  db = null;
  initPromise = null;
}

function rowToRecord(row: Record<string, unknown>): HistoryRecord {
  return {
    id: Number(row.id),
    url: String(row.url),
    title: String(row.title),
    imageCount: Number(row.image_count),
    successCount: Number(row.success_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count),
    saveDir: String(row.save_dir),
    status: String(row.status) as HistoryStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/* ------------------------------------------------------------------ */
/* Export the migration list for tests to introspect                   */
/* ------------------------------------------------------------------ */
export function _testMigrations(): Migration[] {
  return MIGRATIONS;
}

export type {DB};