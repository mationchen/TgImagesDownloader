// Node 22 built-in SQLite: real SQL tests without adding an app/native dependency.
const { DatabaseSync } = require('node:sqlite');
import { open, type DB } from '@op-engineering/op-sqlite';
import {
  closeHistoryDatabase, initHistoryDatabase, getDb, getHistory, listHistory,
  upsertHistory, markImageDownloaded, moveImagesToTrash, restoreTrashedImage,
  listTrashedImages, finishPurgingTrashedImage, isImageDownloaded,
  listFavoriteImages, setImageFavorite, _testMigrations, runMigrations,
  reorderHistoryImages,
} from '../src/services/historyService';

let sqlite: any;
let database: DB;
function makeDatabase(): DB {
  const executeSync = (sql: string, params: unknown[] = []) => {
    const statement = sqlite.prepare(sql);
    if (statement.columns().length) return { rows: statement.all(...params as never[]) };
    const result = statement.run(...params as never[]);
    return { rows: [], rowsAffected: Number(result.changes), insertId: Number(result.lastInsertRowid) };
  };
  const adapter = {
    executeSync,
    execute: async (sql: string, params?: unknown[]) => executeSync(sql, params),
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      sqlite.exec('BEGIN;');
      try { await callback(adapter); sqlite.exec('COMMIT;'); }
      catch (err) { sqlite.exec('ROLLBACK;'); throw err; }
    },
    close: async () => undefined,
  };
  return adapter as unknown as DB;
}

beforeEach(async () => {
  await closeHistoryDatabase();
  sqlite = new DatabaseSync(':memory:');
  database = makeDatabase();
  (open as jest.Mock).mockReturnValue(database);
});
afterEach(async () => { await closeHistoryDatabase(); sqlite.close(); });

async function seed() {
  await upsertHistory({ url: 'https://article.test/a', title: 'Gallery',
    imageCount: 3, successCount: 2, failedCount: 1, skippedCount: 0, saveDir: 'Pictures/test', status: 'partial',
    imageUrls: ['https://img.test/1.jpg', 'https://img.test/failed.jpg', 'https://img.test/3.jpg'],
    imagePaths: ['content://media/1', 'content://media/3'], savePaths: ['1.jpg', '3.jpg'],
  });
  await markImageDownloaded('https://img.test/1.jpg', 'content://media/1');
  await markImageDownloaded('https://img.test/3.jpg', 'content://media/3');
  return (await listHistory())[0].id;
}

it.each([0, 5, 10, 11])('real SQLite: upgrades schema v%i through v12 in order', async version => {
  for (const migration of _testMigrations().filter(m => m.version <= version)) {
    await migration.up(database);
    sqlite.exec(`PRAGMA user_version = ${migration.version};`);
  }
  await initHistoryDatabase();
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(12);
  expect(await listTrashedImages()).toEqual([]);
});

it('migration failure rolls back table, schema version and preserves existing data', async () => {
  for (const migration of _testMigrations().filter(m => m.version <= 11)) {
    await migration.up(database);
    sqlite.exec(`PRAGMA user_version = ${migration.version};`);
  }
  sqlite.exec("INSERT INTO settings VALUES ('keep', 'safe', 1)");
  const original = database.execute.bind(database);
  database.execute = jest.fn(async (sql, params) => {
    if (sql.includes('idx_image_trash_time')) throw new Error('injected');
    return original(sql, params);
  });
  await expect(runMigrations(database)).rejects.toThrow('injected');
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(11);
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'image_trash'").all()).toEqual([]);
  expect(sqlite.prepare('SELECT value FROM settings WHERE key = ?').get('keep')?.value).toBe('safe');
});

it('before v12, creates a consistent recovery snapshot containing the old schema and data', async () => {
  for (const migration of _testMigrations().filter(m => m.version <= 11)) {
    await migration.up(database);
    sqlite.exec(`PRAGMA user_version = ${migration.version};`);
  }
  sqlite.exec("INSERT INTO settings VALUES ('keep', 'backup-data', 1)");
  const path = require('path').join(require('os').tmpdir(), `tg-image-trash-${Date.now()}`);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(123456789);
  database.getDbPath = () => path;
  const backupPath = `${path}.before-v12.123456789.bak`;
  try {
    await initHistoryDatabase();
    const snapshot = new DatabaseSync(backupPath);
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()?.user_version).toBe(11);
      expect(snapshot.prepare('SELECT value FROM settings WHERE key = ?').get('keep')?.value).toBe('backup-data');
    } finally { snapshot.close(); }
  } finally {
    clock.mockRestore();
    // Only this test's newly generated temporary snapshot; never an app database.
    if (require('fs').existsSync(backupPath)) require('fs').unlinkSync(backupPath);
  }
});

it('partial download: maps source by URI ledger, not by mismatched array indices; duplicate moves are idempotent', async () => {
  const id = await seed();
  expect(await moveImagesToTrash(id, ['content://media/3', 'content://media/3'])).toBe(1);
  expect(await moveImagesToTrash(id, ['content://media/3'])).toBe(0);
  expect((await listTrashedImages())[0].url).toBe('https://img.test/3.jpg');
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/1']);
  expect((await getHistory(id))?.savePaths).toEqual(['1.jpg']);
  expect(await isImageDownloaded('https://img.test/3.jpg')).toBe(true);
  await restoreTrashedImage('content://media/3');
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/1', 'content://media/3']);
  expect((await getHistory(id))?.imageUrls).toHaveLength(3);
});

it('all hidden images do not fall back to source URLs; cover and favorites hide and restore', async () => {
  const id = await seed();
  await getDb().execute('UPDATE history SET cover_uri = ? WHERE id = ?', ['content://media/3', id]);
  await setImageFavorite('content://media/3', true, { recordId: id });
  await moveImagesToTrash(id, ['content://media/1', 'content://media/3']);
  const record = await getHistory(id);
  expect(record?.hasStoredImages).toBe(true);
  expect(record?.imagePaths).toEqual([]);
  expect(record?.imageUrls).toEqual([]);
  expect(record?.coverUri).toBe('');
  expect(await listFavoriteImages()).toEqual([]);
  await restoreTrashedImage('content://media/3');
  expect((await getHistory(id))?.coverUri).toBe('content://media/3');
  expect(await listFavoriteImages()).toHaveLength(1);
});

it('rejects a foreign URI and rolls back the entire move', async () => {
  const id = await seed();
  await expect(moveImagesToTrash(id, ['content://media/1', 'content://other/9'])).rejects.toThrow();
  expect(await listTrashedImages()).toEqual([]);
});

it('permanent deletion clears only the matching ledger, keeps tombstone, allows a new download URI', async () => {
  const id = await seed();
  await moveImagesToTrash(id, ['content://media/3']);
  await finishPurgingTrashedImage('content://media/3');
  expect(await listTrashedImages()).toEqual([]);
  expect(await isImageDownloaded('https://img.test/3.jpg')).toBe(false);
  expect(await isImageDownloaded('https://img.test/1.jpg')).toBe(true);
  await restoreTrashedImage('content://media/3');
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/1']);
  await markImageDownloaded('https://img.test/3.jpg', 'content://media/new3');
  await getDb().execute('UPDATE history SET image_paths = ? WHERE id = ?', [JSON.stringify(['content://media/1', 'content://media/new3']), id]);
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/1', 'content://media/new3']);
});

it('URI identity hides shared files from every record without deleting either record', async () => {
  const id = await seed();
  await getDb().execute(`INSERT INTO history (url, title, created_at, updated_at, image_paths)
    VALUES ('https://article.test/b', 'Shared', 1, 1, ?);`, [JSON.stringify(['content://media/3'])]);
  await moveImagesToTrash(id, ['content://media/3']);
  const records = await listHistory();
  expect(records).toHaveLength(2);
  expect(records.every(r => !r.imagePaths.includes('content://media/3'))).toBe(true);
});

it('reorders visible images without dropping hidden slots; restore returns the hidden image to its slot', async () => {
  const id = await seed();
  await getDb().execute('UPDATE history SET image_paths = ?, save_paths = ? WHERE id = ?',
    [JSON.stringify(['content://media/1', 'content://media/hidden', 'content://media/3']), JSON.stringify(['1', 'hidden', '3']), id]);
  await moveImagesToTrash(id, ['content://media/hidden']);
  await reorderHistoryImages(id, [1, 0]);
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/3', 'content://media/1']);
  await restoreTrashedImage('content://media/hidden');
  expect((await getHistory(id))?.imagePaths).toEqual(['content://media/3', 'content://media/hidden', 'content://media/1']);
});

it('does not silently discard a recycled image if its parent record has been permanently removed', async () => {
  const id = await seed();
  await moveImagesToTrash(id, ['content://media/3']);
  await getDb().execute('DELETE FROM history WHERE id = ?;', [id]);
  await expect(restoreTrashedImage('content://media/3')).rejects.toThrow('IMAGE_TRASH_RECORD_MISSING');
  expect(await listTrashedImages()).toHaveLength(1);
});
