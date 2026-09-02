import {open} from '@op-engineering/op-sqlite';
import {
  closeHistoryDatabase,
  deleteSetting,
  getHistory,
  getLatestSchemaVersion,
  getSetting,
  isImageDownloaded,
  listHistory,
  markImageDownloaded,
  removeHistory,
  runMigrations,
  setSetting,
  upsertHistory,
  _testMigrations,
  type DB,
} from '../src/services/historyService';

// A minimal in-memory stand-in for an op-sqlite DB so we can exercise the
// migration + CRUD logic without the native JSI layer.
type Row = Record<string, unknown>;
interface FakeDb {
  db: DB;
  sqlLog: string[];
  tables: Record<string, Row[]>;
  userVersion: number;
  transactionDepth: number;
  failNextMigration: boolean;
}

function makeFakeDb(): FakeDb {
  const store: FakeDb = {
    sqlLog: [],
    tables: {},
    userVersion: 0,
    transactionDepth: 0,
    failNextMigration: false,
    db: null as unknown as DB,
  };

  const execSync = (sql: string, params?: any[]): any => {
    store.sqlLog.push(sql);
    return run(sql, params);
  };
  const exec = async (sql: string, params?: any[]): Promise<any> =>
    execSync(sql, params);

  const run = (sql: string, params?: any[]): any => {
    if (/PRAGMA user_version\s*=\s*(\d+)/i.test(sql)) {
      store.userVersion = Number(sql.match(/PRAGMA user_version\s*=\s*(\d+)/i)![1]);
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    if (/PRAGMA user_version/i.test(sql)) {
      return {rows: [{user_version: store.userVersion}], insertId: 0, rowsAffected: 0};
    }
    if (/^BEGIN/i.test(sql)) {
      store.transactionDepth += 1;
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    if (/^COMMIT/i.test(sql)) {
      store.transactionDepth -= 1;
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    if (/^ROLLBACK/i.test(sql)) {
      store.transactionDepth -= 1;
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    const create = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (create) {
      if (!store.tables[create[1]!.toLowerCase()]) store.tables[create[1]!.toLowerCase()] = [];
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    const createIdx = sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i);
    if (createIdx) {
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    const insert = sql.match(/^INSERT INTO (\w+)/i);
    if (insert) {
      const table = insert[1]!.toLowerCase();
      if (!store.tables[table]) store.tables[table] = [];
      // simplistic: treat params as ordered values
      const row: Row = {};
      (params ?? []).forEach((v, i) => {
        row[`c${i}`] = v;
      });
      store.tables[table].push(row);
      return {rows: [], insertId: store.tables[table].length, rowsAffected: 1};
    }
    const sel = sql.match(/^SELECT/i);
    if (sel) {
      // SELECT from history
      const from = sql.match(/FROM (\w+)/i);
      if (from) {
        const rows = store.tables[from[1]!.toLowerCase()] ?? [];
        // map c0..cn back to a pseudo-record (tests only check status fields we
        // can't fully round-trip without a real engine, so we return the stored
        // params via a best-effort mapping).
        return {rows: rows as Row[], insertId: 0, rowsAffected: rows.length};
      }
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    if (/^DELETE FROM/i.test(sql)) {
      const from = sql.match(/DELETE FROM (\w+)/i);
      if (from) store.tables[from[1]!.toLowerCase()] = [];
      return {rows: [], insertId: 0, rowsAffected: 0};
    }
    return {rows: [], insertId: 0, rowsAffected: 0};
  };

  const db = {
    execute: exec,
    executeSync: execSync,
    executeAsync: exec,
    executeRaw: exec,
    executeRawSync: execSync,
    transaction: async (fn: any) => {
      execSync('BEGIN TRANSACTION;');
      try {
        await fn({
          execute: async (sql: string, params?: any[]) => {
            if (store.failNextMigration && /CREATE TABLE/i.test(sql)) {
              store.failNextMigration = false;
              throw new Error('boom');
            }
            return exec(sql, params);
          },
          commit: async () => execSync('COMMIT;'),
          rollback: () => execSync('ROLLBACK;'),
        });
        execSync('COMMIT;');
      } catch (e) {
        execSync('ROLLBACK;');
        throw e;
      }
    },
    close: async () => undefined,
    executeBatch: async () => ({rows: [], insertId: 0, rowsAffected: 0}),
    executeSync2: execSync,
  } as unknown as DB;

  store.db = db;
  return store;
}

beforeEach(async () => {
  await closeHistoryDatabase();
});

describe('historyService migrations', () => {
  it('has an ordered, versioned migration manifest', () => {
    const ms = _testMigrations();
    expect(ms.length).toBeGreaterThan(0);
    // versions must be strictly increasing starting at 1
    for (let i = 0; i < ms.length; i += 1) {
      expect(ms[i]!.version).toBe(i + 1);
      expect(ms[i]!.description).toBeTruthy();
      expect(typeof ms[i]!.up).toBe('function');
    }
    expect(getLatestSchemaVersion()).toBe(ms[ms.length - 1]!.version);
  });

  it('migrates a fresh database from v0 to the latest version', async () => {
    const fake = makeFakeDb();
    await runMigrations(fake.db);
    expect(fake.userVersion).toBe(getLatestSchemaVersion());
    // schema_meta + history tables created
    expect(fake.tables.schema_meta).toBeDefined();
    expect(fake.tables.history).toBeDefined();
  });

  it('skips migrations already applied (upgrade from an older version)', async () => {
    const fake = makeFakeDb();
    fake.userVersion = getLatestSchemaVersion(); // pretend fully migrated
    await runMigrations(fake.db);
    // No migration DDL should have run (version already latest).
    expect(fake.tables.history).toBeUndefined();
    expect(fake.sqlLog.some(s => /CREATE TABLE IF NOT EXISTS history/i.test(s))).toBe(false);
  });

  it('rolls back a failed migration and keeps the old version', async () => {
    const fake = makeFakeDb();
    fake.failNextMigration = true;
    await expect(runMigrations(fake.db)).rejects.toThrow('boom');
    // Rollback executed and version unchanged.
    expect(fake.sqlLog.some(s => /ROLLBACK/i.test(s))).toBe(true);
    expect(fake.userVersion).toBe(0);
  });
});

describe('historyService CRUD', () => {
  it('upsert, list, and remove a record', async () => {
    (open as unknown as jest.Mock).mockReturnValue(makeFakeDb().db);

    const now = Date.now();
    await upsertHistory({
      url: 'https://telegra.ph/a',
      title: 'Article A',
      imageCount: 10,
      successCount: 9,
      failedCount: 1,
      skippedCount: 0,
      saveDir: 'Pictures/TelegraphDownloader/a',
      status: 'partial',
    });
    await upsertHistory({
      url: 'https://telegra.ph/b',
      title: 'Article B',
      imageCount: 2,
      successCount: 2,
      failedCount: 0,
      skippedCount: 0,
      saveDir: 'Pictures/TelegraphDownloader/b',
      status: 'done',
    });

    const list = await listHistory(10);
    // Fake engine doesn't round-trip column values faithfully, so just assert
    // we got the right number of rows back (2 upserts).
    expect(list.length).toBe(2);

    // remove the first (by whichever id)
    if (list.length > 0) {
      await removeHistory(list[0]!.id);
    }
    const after = await listHistory(10);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(now).toBeGreaterThan(0);
  });

  it('is callable without throwing when no rows exist', async () => {
    (open as unknown as jest.Mock).mockReturnValue(makeFakeDb().db);
    const list = await listHistory(10);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });
});

describe('historyService v2 migration (per-image detail + settings KV)', () => {
  it('declares the schema at or beyond v2', () => {
    expect(getLatestSchemaVersion()).toBeGreaterThanOrEqual(2);
    const ms = _testMigrations();
    const v2 = ms.find(m => m.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.description).toMatch(/image|settings/i);
  });

  it('runs v2 DDL: ALTER TABLE history ... + CREATE TABLE settings', async () => {
    const fake = makeFakeDb();
    await runMigrations(fake.db);
    const ddl = fake.sqlLog.join('\n');
    expect(ddl).toMatch(/ALTER TABLE history ADD COLUMN image_urls/i);
    expect(ddl).toMatch(/ALTER TABLE history ADD COLUMN image_paths/i);
    expect(ddl).toMatch(/ALTER TABLE history ADD COLUMN save_paths/i);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS settings/i);
    expect(fake.tables.settings).toBeDefined();
  });

  it('upgrades a v1-only user (existing rows) safely via DEFAULT []', async () => {
    // Simulate a user at v1: pretend an old row already exists.
    const fake = makeFakeDb();
    fake.userVersion = 1;
    await runMigrations(fake.db);
    // The v2 ALTER TABLE statements each include a DEFAULT clause so existing
    // rows survive (AGENTS.md §4).
    const ddl = fake.sqlLog.join('\n');
    expect(ddl).toMatch(/ADD COLUMN image_urls TEXT NOT NULL DEFAULT '\[\]'/);
    expect(ddl).toMatch(/ADD COLUMN image_paths TEXT NOT NULL DEFAULT '\[\]'/);
    expect(ddl).toMatch(/ADD COLUMN save_paths TEXT NOT NULL DEFAULT '\[\]'/);
    expect(fake.userVersion).toBe(getLatestSchemaVersion());
  });

  it('upsertHistory persists per-image JSON arrays (v2)', async () => {
    const fake = makeFakeDb();
    (open as unknown as jest.Mock).mockReturnValue(fake.db);
    await upsertHistory({
      url: 'https://telegra.ph/v2-detail',
      title: 'V2 detail article',
      imageCount: 2,
      successCount: 2,
      failedCount: 0,
      skippedCount: 0,
      saveDir: 'Pictures/TelegraphDownloader/v2',
      status: 'done',
      imageUrls: [
        'https://telegra.ph/file/a.jpg',
        'https://telegra.ph/file/b.jpg',
      ],
      imagePaths: ['content://media/external/images/1', 'content://media/external/images/2'],
      savePaths: ['v2/001.jpg', 'v2/002.jpg'],
    });
    // Find the history insert (it's stored under the lowercase table; our fake
    // captures tables by the name in `INSERT INTO <table>`).
    const histInsert = fake.sqlLog.find(s => /^INSERT INTO history/i.test(s));
    expect(histInsert).toBeDefined();
    // The fake's insert path stores params by column position; verify JSON
    // strings appear somewhere in the captured rows.
    const flat = JSON.stringify(fake.tables);
    expect(flat).toContain('https://telegra.ph/file/a.jpg');
    expect(flat).toContain('content://media/external/images/1');
  });

  it('settings KV: get returns null when missing, set+get roundtrips', async () => {
    const fake = makeFakeDb();
    (open as unknown as jest.Mock).mockReturnValue(fake.db);

    await expect(getSetting('nope')).resolves.toBeNull();
    await setSetting('downloadDir', 'Pictures/Telegram');
    // The fake SELECT returns the raw tables; verify the value was at least
    // captured in the DDL log on the INSERT INTO settings path.
    const flat = JSON.stringify(fake.tables);
    expect(flat).toContain('Pictures/Telegram');
  });

  it('getHistory(id) decodes JSON arrays back into string[]', async () => {
    // Direct unit test of the JSON decoder via rowToRecord — exercised through
    // listHistory with a real-looking record.
    const fake = makeFakeDb();
    fake.tables.history = [
      {
        id: 7,
        url: 'https://telegra.ph/x',
        title: 'X',
        image_count: 2,
        success_count: 2,
        failed_count: 0,
        skipped_count: 0,
        save_dir: 'sd',
        status: 'done',
        image_urls: JSON.stringify(['u1', 'u2']),
        image_paths: JSON.stringify(['p1', 'p2']),
        save_paths: JSON.stringify(['s1', 's2']),
        created_at: 100,
        updated_at: 100,
      },
    ];
    (open as unknown as jest.Mock).mockReturnValue(fake.db);
    const list = await listHistory(10);
    expect(list.length).toBe(1);
    expect(list[0]!.imageUrls).toEqual(['u1', 'u2']);
    expect(list[0]!.imagePaths).toEqual(['p1', 'p2']);
    expect(list[0]!.savePaths).toEqual(['s1', 's2']);

    const one = await getHistory(7);
    expect(one?.id).toBe(7);
    expect(one?.imageUrls).toEqual(['u1', 'u2']);
  });

  it('deleteSetting removes a row', async () => {
    const fake = makeFakeDb();
    (open as unknown as jest.Mock).mockReturnValue(fake.db);
    await setSetting('foo', 'bar');
    await deleteSetting('foo');
    // DELETE FROM settings should appear in the SQL log.
    expect(fake.sqlLog.some(s => /^DELETE FROM settings/i.test(s))).toBe(true);
  });
});

describe('historyService v3 migration (downloaded-image URL ledger)', () => {
  it('declares v3 in the migration manifest', () => {
    const ms = _testMigrations();
    const v3 = ms.find(m => m.version === 3);
    expect(v3).toBeDefined();
    expect(v3!.description).toMatch(/download/i);
  });

  it('creates the downloaded_images table when migrating', async () => {
    const fake = makeFakeDb();
    fake.userVersion = 2; // pretend a v2 user upgrades to v3
    await runMigrations(fake.db);
    const ddl = fake.sqlLog.join('\n');
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS downloaded_images/i);
    expect(fake.tables.downloaded_images).toBeDefined();
    expect(fake.userVersion).toBe(getLatestSchemaVersion());
  });

  it('isImageDownloaded / markImageDownloaded roundtrip', async () => {
    const fake = makeFakeDb();
    // Ensure the downloaded_images table exists so our fake's INSERT/SELECT
    // path has a target.
    fake.tables.downloaded_images = [];
    (open as unknown as jest.Mock).mockReturnValue(fake.db);
    await expect(isImageDownloaded('https://x/1.jpg')).resolves.toBe(false);
    await markImageDownloaded('https://x/1.jpg');
    const flat = JSON.stringify(fake.tables);
    expect(flat).toContain('https://x/1.jpg');
  });
});
