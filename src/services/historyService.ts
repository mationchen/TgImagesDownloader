import { open, type DB } from '@op-engineering/op-sqlite';
import type { Scalar } from '@op-engineering/op-sqlite';
import { computeSummary, type DownloadState } from '../store/downloadReducer';
import { APP_CONFIG } from '../constants/config';

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
  /** Source image URLs (in download order). Empty for records made before v2. */
  imageUrls: string[];
  /**
   * MediaStore content:// URIs for each successfully saved image (in download
   * order). Empty for records made before v2.
   */
  imagePaths: string[];
  /**
   * Relative MediaStore paths (e.g. "Pictures/TelegraphDownloader/foo/001.jpg")
   * in download order. Empty for records made before v2.
   */
  savePaths: string[];
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
  /** Source image URLs (in download order). Defaults to []. */
  imageUrls?: string[];
  /** MediaStore content URIs for saved images (in download order). */
  imagePaths?: string[];
  /** Relative MediaStore paths for saved images (in download order). */
  savePaths?: string[];
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
  imageUrls: string[];
  imagePaths: string[];
  savePaths: string[];
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

export const LATEST_SCHEMA_VERSION = 4;

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
  {
    version: 2,
    description:
      'Per-image detail columns (image_urls/image_paths/save_paths) + settings KV table',
    up: async db => {
      // Add per-image detail columns. Stored as JSON-encoded arrays so we
      // don't need a separate child table for the MVP. Defaults to '[]' so
      // existing rows survive the migration cleanly (AGENTS.md §4).
      await db.execute(
        `ALTER TABLE history ADD COLUMN image_urls TEXT NOT NULL DEFAULT '[]';`,
      );
      await db.execute(
        `ALTER TABLE history ADD COLUMN image_paths TEXT NOT NULL DEFAULT '[]';`,
      );
      await db.execute(
        `ALTER TABLE history ADD COLUMN save_paths TEXT NOT NULL DEFAULT '[]';`,
      );

      // Settings KV store (used by SettingsScreen for download preferences).
      await db.execute(
        `CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );`,
      );
    },
  },
  {
    version: 3,
    description:
      'downloaded_images ledger: source image URLs that were successfully saved, for duplicate skip',
    up: async db => {
      // Tracks every successfully-saved source image URL so a later "re-download
      // the same URL" can be skipped without fetching the bytes again. Keyed by
      // source URL (not by generated filename) because the filename embeds the
      // date, so it is not a stable identity across days.
      await db.execute(
        `CREATE TABLE IF NOT EXISTS downloaded_images (
          url TEXT PRIMARY KEY,
          saved_at INTEGER NOT NULL
        );`,
      );
    },
  },
  {
    version: 4,
    description:
      'downloaded_images: store the saved local URI so an all-skipped re-run can still link its images',
    up: async db => {
      // A re-run of an already-downloaded article produces a history row whose
      // tasks are all "skipped". Without the saved URI those rows cannot show
      // their images (the shared save folder holds every article's files).
      // Default '' so existing ledger rows survive the migration (AGENTS.md §4).
      await db.execute(
        `ALTER TABLE downloaded_images ADD COLUMN local_path TEXT NOT NULL DEFAULT '';`,
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
  db = open({ name: getDatabaseName() });
  await runMigrations(db);
}

export function getDb(): DB {
  if (!db) {
    throw new Error(
      'history database not initialised; call initHistoryDatabase() first',
    );
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
 * On conflict, the counters, status, and per-image details are overwritten
 * with the latest run — EXCEPT the per-image URI arrays: if the new run
 * produced an empty array (e.g. a pure "already downloaded, skip" re-run), the
 * previously recorded URIs are kept instead of being wiped, so the history
 * detail grid keeps its thumbnails and the save path list stays meaningful.
 */
export async function upsertHistory(input: UpsertHistoryInput): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  const now = Date.now();
  const imageUrls = JSON.stringify(input.imageUrls ?? []);
  const imagePaths = JSON.stringify(input.imagePaths ?? []);
  const savePaths = JSON.stringify(input.savePaths ?? []);
  await d.execute(
    `INSERT INTO history
       (url, title, image_count, success_count, failed_count, skipped_count,
        save_dir, status, image_urls, image_paths, save_paths,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       image_count = excluded.image_count,
       success_count = excluded.success_count,
       failed_count = excluded.failed_count,
       skipped_count = excluded.skipped_count,
       save_dir = excluded.save_dir,
       status = excluded.status,
       image_urls = CASE WHEN excluded.image_urls = '[]' THEN history.image_urls ELSE excluded.image_urls END,
       image_paths = CASE WHEN excluded.image_paths = '[]' THEN history.image_paths ELSE excluded.image_paths END,
       save_paths = CASE WHEN excluded.save_paths = '[]' THEN history.save_paths ELSE excluded.save_paths END,
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
      imageUrls,
      imagePaths,
      savePaths,
      now,
      now,
    ],
  );
}

/**
 * List history records newest first, paginated.
 *
 * @param limit   Max rows to return (cap, not page size).
 * @param offset  Number of rows to skip from the newest end (>=0 for
 *                chronological pages: 0 = newest 0..limit-1, 100 = next page
 *                starting at row 101, etc.).
 * @param filter  Optional title / date-range predicate applied in SQL so the
 *                pagination math stays correct under filtering.
 */
export async function listHistory(
  limit = 100,
  offset = 0,
  filter?: HistoryListFilter,
): Promise<HistoryRecord[]> {
  await initHistoryDatabase();
  const d = getDb();
  const { whereSql, params } = buildHistoryFilter(filter);
  const res = await d.execute(
    `SELECT id, url, title, image_count, success_count, failed_count,
            skipped_count, save_dir, status, image_urls, image_paths, save_paths,
            created_at, updated_at
     FROM history
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?;`,
    [...params, limit, Math.max(0, offset)],
  );
  return (res.rows ?? []).map(rowToRecord);
}

/** Optional predicate for {@link listHistory} / {@link countHistory}. */
export interface HistoryListFilter {
  /** Case-insensitive substring match on the article title. */
  title?: string;
  /** Inclusive lower bound on created_at (UTC ms). */
  createdAfterMs?: number;
  /** Exclusive upper bound on created_at (UTC ms). */
  createdBeforeMs?: number;
}

/**
 * Turn a {@link HistoryListFilter} into a reusable SQL WHERE clause + params.
 * The caller owns the placeholders, so this helper returns only the WHERE
 * text and bound params (no LIMIT/OFFSET).
 */
function buildHistoryFilter(filter?: HistoryListFilter): {
  whereSql: string;
  params: Scalar[];
} {
  if (!filter) return { whereSql: '', params: [] };
  const clauses: string[] = [];
  const params: Scalar[] = [];
  const title = filter.title?.trim();
  if (title) {
    clauses.push('title LIKE ?');
    // Escape LIKE wildcards so user input matches literally.
    const escaped = title.replace(/[\\%_]/g, m => `\\${m}`);
    params.push(`%${escaped}%`);
  }
  if (filter.createdAfterMs != null) {
    clauses.push('created_at >= ?');
    params.push(filter.createdAfterMs);
  }
  if (filter.createdBeforeMs != null) {
    clauses.push('created_at < ?');
    params.push(filter.createdBeforeMs);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * Count history rows (optionally matching a filter). Used by the
 * HistoryScreen to decide whether a "next page" exists when the user has
 * loaded the current one fully.
 */
export async function countHistory(
  filter?: HistoryListFilter,
): Promise<number> {
  await initHistoryDatabase();
  const d = getDb();
  const { whereSql, params } = buildHistoryFilter(filter);
  const res = await d.execute(
    `SELECT COUNT(*) AS n FROM history ${whereSql};`,
    params,
  );
  const row = (res.rows ?? [])[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Per-local-day record counts for the given inclusive local-day window. */
export interface DayCountRecord {
  /** Start-of-local-day timestamp (UTC ms). */
  dayStartMs: number;
  /** Number of history rows created that local day. */
  count: number;
}

/**
 * Aggregate history rows by the *user's local day* (AGENTS.md §6: persist UTC,
 * interpret in device-local time). The calendar uses this to show how many
 * records exist under each date.
 *
 * @param fromStartOfDayMs  Start-of-local-day of the window start (UTC ms).
 * @param toStartOfDayMs    Start-of-local-day of the window end (UTC ms,
 *                          exclusive) — i.e. fromStartOfDayMs + N*DAY_MS.
 */
export async function listDailyCounts(
  fromStartOfDayMs: number,
  toStartOfDayMs: number,
): Promise<DayCountRecord[]> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT created_at FROM history
     WHERE created_at >= ? AND created_at < ?;`,
    [fromStartOfDayMs, toStartOfDayMs],
  );
  const counts = new Map<number, number>();
  for (const row of res.rows ?? []) {
    const ts = Number((row as { created_at?: unknown }).created_at ?? NaN);
    if (!Number.isFinite(ts)) continue;
    const dayStart = startOfLocalDay(ts);
    counts.set(dayStart, (counts.get(dayStart) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([dayStartMs, count]) => ({ dayStartMs, count }))
    .sort((a, b) => a.dayStartMs - b.dayStartMs);
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Fetch a single history record by id (returns null if not found). */
export async function getHistory(id: number): Promise<HistoryRecord | null> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT id, url, title, image_count, success_count, failed_count,
            skipped_count, save_dir, status, image_urls, image_paths, save_paths,
            created_at, updated_at
     FROM history
     WHERE id = ?
     LIMIT 1;`,
    [id],
  );
  const row = (res.rows ?? [])[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Find the most recent history row for a given article URL (exact match).
 * Used on the Home screen to warn the user before re-parsing an article that
 * has already been downloaded.
 */
export async function findHistoryByUrl(
  url: string,
): Promise<HistoryRecord | null> {
  const target = (url ?? '').trim();
  if (!target) return null;
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT id, url, title, image_count, success_count, failed_count,
            skipped_count, save_dir, status, image_urls, image_paths, save_paths,
            created_at, updated_at
     FROM history
     WHERE url = ?
     ORDER BY created_at DESC
     LIMIT 1;`,
    [target],
  );
  const row = (res.rows ?? [])[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Bulk variant: for each URL, find the most-recent history row (if any).
 * URLs that are not in the history are omitted from the returned map. Used
 * by the batch URL-download screen to skip URLs that were already
 * downloaded in a previous session.
 *
 * Implementation: one `SELECT ... WHERE url = ? ORDER BY … LIMIT 1` per
 * URL. This is O(N) roundtrips but the typical batch is 10–500 URLs and
 * each query is a primary-key lookup, so the total wall time is
 * acceptable (and much simpler than a JOIN-based approach).
 */
export async function listHistoryByUrls(
  urls: readonly string[],
): Promise<Map<string, HistoryRecord>> {
  const cleaned = Array.from(
    new Set(urls.map(s => (s ?? '').trim()).filter(Boolean)),
  );
  if (cleaned.length === 0) return new Map();
  await initHistoryDatabase();
  const d = getDb();
  const out = new Map<string, HistoryRecord>();
  for (const url of cleaned) {
    const res = await d.execute(
      `SELECT id, url, title, image_count, success_count, failed_count,
              skipped_count, save_dir, status, image_urls, image_paths,
              save_paths, created_at, updated_at
         FROM history
        WHERE url = ?
        ORDER BY created_at DESC
        LIMIT 1;`,
      [url],
    );
    const row = (res.rows ?? [])[0];
    if (row) {
      const rec = rowToRecord(row);
      if (rec) out.set(rec.url, rec);
    }
  }
  return out;
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
    imageUrls: decodeJsonArray(row.image_urls),
    imagePaths: decodeJsonArray(row.image_paths),
    savePaths: decodeJsonArray(row.save_paths),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function decodeJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Downloaded-image URL ledger                                          */
/* ------------------------------------------------------------------ */

/**
 * Record that {@code url} was successfully saved. Used so re-downloading the
 * same source URL can be skipped (AGENTS.md duplicate policy).
 *
 * {@code localPath} is the saved content/MediaStore URI. It is what lets an
 * all-skipped re-run still display its images in 下载记录 (v4).
 */
export async function markImageDownloaded(
  url: string,
  localPath?: string,
): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute(
    `INSERT INTO downloaded_images (url, saved_at, local_path)
     VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       saved_at = excluded.saved_at,
       local_path = CASE
         WHEN excluded.local_path = '' THEN downloaded_images.local_path
         ELSE excluded.local_path
       END;`,
    [url, Date.now(), localPath ?? ''],
  );
}

/** True if {@code url} was already successfully downloaded before. */
export async function isImageDownloaded(url: string): Promise<boolean> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT url FROM downloaded_images WHERE url = ? LIMIT 1;`,
    [url],
  );
  return (res.rows ?? []).length > 0;
}

/**
 * Look up the saved local URI for each already-downloaded URL.
 *
 * Used when recording an all-skipped history row: those tasks carry no
 * `localPath` (nothing was saved this run), but the ledger still remembers
 * where the bytes were written last time. Only non-empty paths are returned.
 */
export async function getDownloadedImagePaths(
  urls: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  await initHistoryDatabase();
  const d = getDb();
  for (const url of urls) {
    try {
      const res = await d.execute(
        `SELECT local_path FROM downloaded_images WHERE url = ? LIMIT 1;`,
        [url],
      );
      const row = (res.rows ?? [])[0] as { local_path?: unknown } | undefined;
      const path = row?.local_path;
      if (typeof path === 'string' && path.length > 0) out.set(url, path);
    } catch {
      // Best-effort: a missing path simply leaves that image out of the grid.
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Persist a finished download run                                      */
/* ------------------------------------------------------------------ */

/** Map a run's failure ratio to the history status shown in 下载记录. */
export function deriveHistoryStatus(
  failed: number,
  total: number,
): HistoryStatus {
  if (failed === 0) return 'done';
  if (failed === total) return 'failed';
  return 'partial';
}

/**
 * Persist one finished download run as a history row.
 *
 * Shared by the Home (DownloadScreen) and batch (BatchListScreen via
 * DownloadContext.runDownload) flows so a URL downloaded through either path
 * appears in 下载记录 with identical fields. Builds the per-image arrays in
 * download order (taskOrder) and only records a path for tasks that actually
 * produced a local file.
 *
 * Best-effort: callers should swallow/normalise failures rather than surface
 * them, since history persistence must never block the download UI.
 */
export async function recordHistoryFromState(
  state: DownloadState,
): Promise<void> {
  const article = state.article;
  if (!article?.url) return;
  const saveDir =
    state.subfolder || `${APP_CONFIG.download.defaultSaveDir}/untitled`;
  const order = state.taskOrder ?? [];
  const images = article.images ?? [];

  // Photos skipped this run carry no `localPath` (nothing was written now),
  // but the ledger remembers where they were saved last time. Look those up so
  // an all-skipped re-run still gets a usable detail view.
  const skippedWithoutPath: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!image) continue;
    const task = state.tasks[order[i] ?? image.id];
    if (!task?.localPath && task?.status === 'skipped') {
      skippedWithoutPath.push(image.url);
    }
  }
  let ledgerPaths = new Map<string, string>();
  if (skippedWithoutPath.length > 0) {
    try {
      ledgerPaths = await getDownloadedImagePaths(skippedWithoutPath);
    } catch {
      ledgerPaths = new Map();
    }
  }

  const imageUrls: string[] = [];
  const imagePaths: string[] = [];
  const savePaths: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!image) continue;
    const task = state.tasks[order[i] ?? image.id];
    imageUrls.push(image.url);
    const localPath = task?.localPath ?? ledgerPaths.get(image.url);
    if (localPath) {
      imagePaths.push(localPath);
      // Only record a save path when *this* run wrote the file; a
      // ledger-resolved path belongs to an earlier run whose generated
      // filename (it embeds a batch token) we can't reproduce.
      if (task?.localPath) savePaths.push(`${saveDir}/${image.filename}`);
    }
  }
  const summary = computeSummary(state);
  await upsertHistory({
    url: article.url,
    title: article.title,
    imageCount: summary.total,
    successCount: summary.success,
    failedCount: summary.failed,
    skippedCount: summary.skipped,
    saveDir,
    status: deriveHistoryStatus(summary.failed, summary.total),
    imageUrls,
    imagePaths,
    savePaths,
  });
}

/* ------------------------------------------------------------------ */
/* Settings KV                                                          */
/* ------------------------------------------------------------------ */

/**
 * Settings KV store. Each key holds a string; callers are responsible for
 * encoding values (e.g. JSON for complex values). Used by the SettingsScreen
 * for download-folder / naming-rule preferences (see module 5).
 */
export async function getSetting(key: string): Promise<string | null> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT value FROM settings WHERE key = ? LIMIT 1;`,
    [key],
  );
  const row = (res.rows ?? [])[0];
  return row ? String(row.value) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  const now = Date.now();
  await d.execute(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at;`,
    [key, value, now],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute(`DELETE FROM settings WHERE key = ?;`, [key]);
}

/* ------------------------------------------------------------------ */
/* Export the migration list for tests to introspect                   */
/* ------------------------------------------------------------------ */
export function _testMigrations(): Migration[] {
  return MIGRATIONS;
}

export type { DB };
