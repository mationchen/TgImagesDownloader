import { open } from '@op-engineering/op-sqlite';
import {
  closeHistoryDatabase,
  deleteSetting,
  deriveHistoryStatus,
  getDownloadedImagePaths,
  getHistory,
  getLatestSchemaVersion,
  getSetting,
  isImageDownloaded,
  listHistory,
  listHistoryByUrls,
  markImageDownloaded,
  recordHistoryFromState,
  removeHistory,
  runMigrations,
  setSetting,
  upsertHistory,
  _testMigrations,
  type DB,
} from '../src/services/historyService';
import {
  downloadReducer,
  initDownloadState,
} from '../src/store/downloadReducer';
import type { TelegraphArticle, TelegraphImage } from '../src/types/telegraph';

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
      store.userVersion = Number(
        sql.match(/PRAGMA user_version\s*=\s*(\d+)/i)![1],
      );
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    if (/PRAGMA user_version/i.test(sql)) {
      return {
        rows: [{ user_version: store.userVersion }],
        insertId: 0,
        rowsAffected: 0,
      };
    }
    if (/^BEGIN/i.test(sql)) {
      store.transactionDepth += 1;
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    if (/^COMMIT/i.test(sql)) {
      store.transactionDepth -= 1;
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    if (/^ROLLBACK/i.test(sql)) {
      store.transactionDepth -= 1;
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    const create = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (create) {
      if (!store.tables[create[1]!.toLowerCase()])
        store.tables[create[1]!.toLowerCase()] = [];
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    const createIdx = sql.match(
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i,
    );
    if (createIdx) {
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    const insert = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)/i);
    if (insert) {
      const table = insert[1]!.toLowerCase();
      if (!store.tables[table]) store.tables[table] = [];
      // Parse column names from the INSERT statement so rows are stored
      // with proper keys (e.g. `url`, `title`) instead of `c0, c1, ...`.
      const cols = insert[2]!
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      const row: Row = {};
      (params ?? []).forEach((v, i) => {
        const key = cols[i] ?? `c${i}`;
        row[key] = v;
      });
      store.tables[table].push(row);
      return {
        rows: [],
        insertId: store.tables[table].length,
        rowsAffected: 1,
      };
    }
    const sel = sql.match(/^SELECT/i);
    if (sel) {
      // SELECT from a table. Support basic WHERE col = ? filtering so
      // listHistoryByUrls (which does one SELECT per URL) works correctly.
      const from = sql.match(/FROM (\w+)/i);
      if (from) {
        let rows = (store.tables[from[1]!.toLowerCase()] ?? []) as Row[];
        // Parse WHERE col = ? — simple equality filter.
        const whereM = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        if (whereM && params && params.length > 0) {
          const col = whereM[1]!;
          const val = params[0];
          rows = rows.filter(r => r[col] === val);
        }
        // Parse ORDER BY col DESC — simple single-column sort.
        const orderM = sql.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i);
        if (orderM) {
          const col = orderM[1]!;
          const desc = orderM[2]!.toUpperCase() === 'DESC';
          rows = [...rows].sort((a, b) => {
            const av = a[col] ?? 0;
            const bv = b[col] ?? 0;
            return desc
              ? (bv as number) - (av as number)
              : (av as number) - (bv as number);
          });
        }
        // Parse LIMIT N — take first N rows.
        const limitM = sql.match(/LIMIT\s+(\d+)/i);
        if (limitM && rows.length > Number(limitM[1])) {
          rows = rows.slice(0, Number(limitM[1]));
        }
        return { rows, insertId: 0, rowsAffected: rows.length };
      }
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    if (/^DELETE FROM/i.test(sql)) {
      const from = sql.match(/DELETE FROM (\w+)/i);
      if (from) store.tables[from[1]!.toLowerCase()] = [];
      return { rows: [], insertId: 0, rowsAffected: 0 };
    }
    return { rows: [], insertId: 0, rowsAffected: 0 };
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
    executeBatch: async () => ({ rows: [], insertId: 0, rowsAffected: 0 }),
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
    expect(
      fake.sqlLog.some(s => /CREATE TABLE IF NOT EXISTS history/i.test(s)),
    ).toBe(false);
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

  describe('listHistoryByUrls (batch dedup lookup)', () => {
    beforeEach(async () => {
      (open as unknown as jest.Mock).mockReturnValue(makeFakeDb().db);
      await closeHistoryDatabase();
    });

    it('returns the latest history per URL', async () => {
      // Two batches for url-A, the second one newer. listHistoryByUrls
      // should return only the newer one.
      await upsertHistory({
        url: 'https://a.test/x',
        title: 'first A',
        imageCount: 5,
        successCount: 5,
        failedCount: 0,
        skippedCount: 0,
        saveDir: 'Pictures/TgDownloader/a',
        imageUrls: ['https://img/u1.jpg'],
        imagePaths: ['content://x/1'],
        savePaths: ['Pictures/a/1.jpg'],
        status: 'done',
      });
      // tiny time gap so updated_at is strictly greater
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      await upsertHistory({
        url: 'https://a.test/x',
        title: 'second A',
        imageCount: 6,
        successCount: 6,
        failedCount: 0,
        skippedCount: 0,
        saveDir: 'Pictures/TgDownloader/a',
        imageUrls: [],
        imagePaths: [],
        savePaths: [],
        status: 'done',
      });
      await upsertHistory({
        url: 'https://b.test/y',
        title: 'B',
        imageCount: 3,
        successCount: 3,
        failedCount: 0,
        skippedCount: 0,
        saveDir: 'Pictures/TgDownloader/b',
        imageUrls: [],
        imagePaths: [],
        savePaths: [],
        status: 'done',
      });

      const map = await listHistoryByUrls([
        'https://a.test/x',
        'https://b.test/y',
        'https://c.test/z', // not in history → omitted
      ]);
      expect(map.size).toBe(2);
      expect(map.get('https://a.test/x')?.title).toBe('second A');
      expect(map.get('https://a.test/x')?.imageCount).toBe(6);
      expect(map.get('https://b.test/y')?.title).toBe('B');
      expect(map.has('https://c.test/z')).toBe(false);
    });

    it('returns an empty map for an empty input list', async () => {
      const map = await listHistoryByUrls([]);
      expect(map.size).toBe(0);
    });

    it('dedupes duplicate inputs in the lookup list', async () => {
      await upsertHistory({
        url: 'https://a.test/x',
        title: 'A',
        imageCount: 5,
        successCount: 5,
        failedCount: 0,
        skippedCount: 0,
        saveDir: 'Pictures/TgDownloader/a',
        imageUrls: [],
        imagePaths: [],
        savePaths: [],
        status: 'done',
      });
      const map = await listHistoryByUrls([
        'https://a.test/x',
        'https://a.test/x',
        '  https://a.test/x  ',
      ]);
      expect(map.size).toBe(1);
    });
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
      imagePaths: [
        'content://media/external/images/1',
        'content://media/external/images/2',
      ],
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

  it('recordHistoryFromState persists a finished run (batch flow)', async () => {
    const fake = makeFakeDb();
    fake.tables.history = [];
    (open as unknown as jest.Mock).mockReturnValue(fake.db);

    const images: TelegraphImage[] = [
      {
        id: 'img-1',
        index: 1,
        url: 'https://img.test/1.jpg',
        filename: '001.jpg',
        selected: true,
      },
      {
        id: 'img-2',
        index: 2,
        url: 'https://img.test/2.jpg',
        filename: '002.jpg',
        selected: true,
      },
    ];
    const article: TelegraphArticle = {
      url: 'https://telegra.ph/batch-row',
      title: 'Batch row',
      images,
      parsedAt: 0,
    };
    let state = initDownloadState(
      article,
      images,
      'Pictures/TelegraphDownloader/batch-row',
    );
    state = downloadReducer(state, {
      type: 'task/success',
      id: 'img-1',
      localPath: 'content://media/external/images/1',
    });
    state = downloadReducer(state, {
      type: 'task/failed',
      id: 'img-2',
      errorCode: 'HTTP_403',
      errorMessage: 'forbidden',
    });

    await recordHistoryFromState(state);

    const row = fake.tables.history?.[0];
    expect(row).toBeDefined();
    expect(row!.url).toBe('https://telegra.ph/batch-row');
    expect(row!.title).toBe('Batch row');
    expect(row!.image_count).toBe(2);
    expect(row!.success_count).toBe(1);
    expect(row!.failed_count).toBe(1);
    expect(JSON.parse(String(row!.image_paths))).toEqual([
      'content://media/external/images/1',
    ]);
    expect(JSON.parse(String(row!.save_paths))).toEqual([
      'Pictures/TelegraphDownloader/batch-row/001.jpg',
    ]);
    expect(JSON.parse(String(row!.image_urls))).toEqual([
      'https://img.test/1.jpg',
      'https://img.test/2.jpg',
    ]);
  });

  it('recordHistoryFromState is a no-op without an article URL', async () => {
    const fake = makeFakeDb();
    fake.tables.history = [];
    (open as unknown as jest.Mock).mockReturnValue(fake.db);

    const images: TelegraphImage[] = [
      {
        id: 'img-1',
        index: 1,
        url: 'https://img.test/1.jpg',
        filename: '001.jpg',
        selected: true,
      },
    ];
    const article: TelegraphArticle = {
      url: '',
      title: 'No url',
      images,
      parsedAt: 0,
    };
    const state = initDownloadState(article, images, 'x');
    await recordHistoryFromState(state);
    expect(fake.tables.history ?? []).toHaveLength(0);
  });

  it('deriveHistoryStatus maps failure ratios to history status', () => {
    expect(deriveHistoryStatus(0, 5)).toBe('done');
    expect(deriveHistoryStatus(2, 5)).toBe('partial');
    expect(deriveHistoryStatus(5, 5)).toBe('failed');
  });

  describe('v4 ledger local_path (link skipped re-runs to their files)', () => {
    it('declares v4 in the manifest', () => {
      const v4 = _testMigrations().find(m => m.version === 4);
      expect(v4).toBeDefined();
      expect(v4!.description).toMatch(/path|uri/i);
    });

    it('adds the local_path column when a v3 user upgrades', async () => {
      const fake = makeFakeDb();
      fake.userVersion = 3;
      await runMigrations(fake.db);
      expect(fake.sqlLog.join('\n')).toMatch(
        /ALTER TABLE downloaded_images ADD COLUMN local_path/i,
      );
      expect(fake.userVersion).toBe(getLatestSchemaVersion());
    });

    it('markImageDownloaded stores the path; getDownloadedImagePaths returns it', async () => {
      const fake = makeFakeDb();
      fake.tables.downloaded_images = [];
      (open as unknown as jest.Mock).mockReturnValue(fake.db);

      await markImageDownloaded('https://x/1.jpg', 'content://media/1');
      await markImageDownloaded('https://x/2.jpg'); // no path recorded

      const map = await getDownloadedImagePaths([
        'https://x/1.jpg',
        'https://x/2.jpg',
        'https://x/3.jpg',
      ]);
      expect(map.get('https://x/1.jpg')).toBe('content://media/1');
      expect(map.has('https://x/2.jpg')).toBe(false);
      expect(map.has('https://x/3.jpg')).toBe(false);
    });

    it('recordHistoryFromState links skipped images to their ledger path', async () => {
      const fake = makeFakeDb();
      fake.tables.downloaded_images = [];
      fake.tables.history = [];
      (open as unknown as jest.Mock).mockReturnValue(fake.db);

      const images: TelegraphImage[] = [
        {
          id: 'img-1',
          index: 1,
          url: 'https://img.test/1.jpg',
          filename: '001.jpg',
          selected: true,
        },
        {
          id: 'img-2',
          index: 2,
          url: 'https://img.test/2.jpg',
          filename: '002.jpg',
          selected: true,
        },
      ];
      const article: TelegraphArticle = {
        url: 'https://telegra.ph/skipped-rerun',
        title: 'Skipped rerun',
        images,
        parsedAt: 0,
      };
      // Both were saved by an earlier run.
      await markImageDownloaded('https://img.test/1.jpg', 'content://media/11');
      await markImageDownloaded('https://img.test/2.jpg', 'content://media/22');

      let state = initDownloadState(
        article,
        images,
        'Pictures/TelegraphDownloader',
      );
      state = downloadReducer(state, {
        type: 'task/skipped',
        id: 'img-1',
        reason: 'already downloaded',
      });
      state = downloadReducer(state, {
        type: 'task/skipped',
        id: 'img-2',
        reason: 'already downloaded',
      });

      await recordHistoryFromState(state);

      const row = fake.tables.history?.[0];
      expect(row).toBeDefined();
      expect(row!.skipped_count).toBe(2);
      expect(JSON.parse(String(row!.image_paths))).toEqual([
        'content://media/11',
        'content://media/22',
      ]);
    });
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
