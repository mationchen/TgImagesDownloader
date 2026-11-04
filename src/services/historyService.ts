import { open, type DB } from '@op-engineering/op-sqlite';
import type { Scalar } from '@op-engineering/op-sqlite';
import { computeSummary, type DownloadState } from '../store/downloadReducer';
import { APP_CONFIG } from '../constants/config';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { likeContainsPattern, tagJsonFragment } from '../utils/searchQuery';

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
  /** 收藏（v5+）。 */
  isFavorite: boolean;
  /** 标记为删除（还没进回收站，仍在列表里显示带标记）。 */
  isMarkedDeleted: boolean;
  /** 移入回收站的时间（UTC ms）；0 = 不在回收站。 */
  trashedAt: number;
  /**
   * 用户手动指定的封面（v6+）。空串 = 用 `imagePaths[0]` 当封面。
   * 列表 / 回收站的缩略图优先用它。
   */
  coverUri: string;
  /**
   * 图集页面上标出的标签（v7+），例如 everia 的 `Cosplay`、tuzac 的 `秀人网`。
   * 空数组 = 该站点本来没有标签，或还没补齐（设置页「补全标签」）。
   */
  tags: string[];
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
  /** 图集标签（v7+）。省略 = 保留库里已有的值。 */
  tags?: string[];
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

/** 所有 history SELECT 共用的列清单（改列时只改这里，rowToRecord 同步）。 */
const HISTORY_COLUMNS =
  'id, url, title, image_count, success_count, failed_count, skipped_count, ' +
  'save_dir, status, image_urls, image_paths, save_paths, created_at, updated_at, ' +
  'is_favorite, is_marked_deleted, trashed_at, cover_uri, tags';

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

export const LATEST_SCHEMA_VERSION = 10;

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
  {
    version: 5,
    description:
      'history: 收藏 / 标记删除 / 回收站三列（v1.0.12 收藏与回收站功能）',
    up: async db => {
      // 三个纯新增列，全部带默认值，旧记录自动落在「未收藏、未标记、不在回收站」，
      // 不需要任何数据回填（AGENTS.md §4：新增列必须能给旧数据兜底）。
      await db.execute(
        `ALTER TABLE history ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;`,
      );
      await db.execute(
        `ALTER TABLE history ADD COLUMN is_marked_deleted INTEGER NOT NULL DEFAULT 0;`,
      );
      // 0 = 不在回收站；> 0 = 移入回收站的时间（UTC ms），用于回收站排序。
      await db.execute(
        `ALTER TABLE history ADD COLUMN trashed_at INTEGER NOT NULL DEFAULT 0;`,
      );
      // 列表默认过滤 trashed_at = 0，收藏页过滤 is_favorite = 1。
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_history_trashed_at
         ON history(trashed_at);`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_history_favorite
         ON history(is_favorite);`,
      );
    },
  },
  {
    version: 6,
    description: 'history: cover_uri 封面列（详情页全屏「设为封面」）',
    up: async db => {
      // 空串 = 用户没指定封面，列表退回 imagePaths[0]；旧数据不需要回填。
      await db.execute(
        `ALTER TABLE history ADD COLUMN cover_uri TEXT NOT NULL DEFAULT '';`,
      );
    },
  },
  {
    version: 7,
    description: 'history: tags 标签列 + tags_checked_at（详情页显示标签 / 补全任务去重）',
    up: async db => {
      // JSON 数组，和 image_urls / save_paths 同一套存法。
      // 默认 '[]'：旧记录先落空标签，之后由设置页的「补全标签」按原网址回填，
      // 不在这里做任何网络/数据回填（AGENTS.md §4）。
      await db.execute(
        `ALTER TABLE history ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';`,
      );
      // 0 = 还没尝试过抓标签；> 0 = 尝试过的时间（UTC ms）。
      // 「页面本来就没有标签」也要记一笔，否则每次补全都会把同一批无标签的
      // 页面重新抓一遍（everia 有几百条这种）。
      await db.execute(
        `ALTER TABLE history ADD COLUMN tags_checked_at INTEGER NOT NULL DEFAULT 0;`,
      );
    },
  },
  {
    version: 8,
    description:
      'deleted_urls 墓碑表（删过的链接留痕）+ listing_items 在线图集候选快照',
    up: async db => {
      // 记录被彻底删除（或清空回收站）的文章地址，用于「在线图集」提示
      // 「这条以前下载过、后来删掉了」，以及批量列表里的同款标记。
      // 重新下载成功时会把对应的行删掉（见 upsertHistory）。
      await db.execute(
        `CREATE TABLE IF NOT EXISTS deleted_urls (
          url TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          deleted_at INTEGER NOT NULL
        );`,
      );
      // 在线图集的候选快照：抓过一次就落库，于是
      //   1) 关闭面板后还能「读取上次列表」；
      //   2) 下次抓取时能标出「上次没入选」的那些。
      await db.execute(
        `CREATE TABLE IF NOT EXISTS listing_items (
          url TEXT PRIMARY KEY,
          site TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          session_id INTEGER NOT NULL DEFAULT 0,
          selected INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER NOT NULL DEFAULT 0
        );`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_listing_items_session
         ON listing_items(session_id);`,
      );
    },
  },
  {
    version: 9,
    description:
      'listing_sessions / listing_session_items：每次抓取各存一份，可挑历史列表',
    up: async db => {
      // 一次抓取 = 一场 session（id 就是开始抓取的时间戳）。
      await db.execute(
        `CREATE TABLE IF NOT EXISTS listing_sessions (
          id INTEGER PRIMARY KEY,
          site TEXT NOT NULL DEFAULT '',
          pages TEXT NOT NULL DEFAULT '',
          total INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );`,
      );
      // 每场会话的候选明细；同一场里 url 唯一，不同场之间互不覆盖。
      await db.execute(
        `CREATE TABLE IF NOT EXISTS listing_session_items (
          session_id INTEGER NOT NULL,
          url TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          selected INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, url)
        );`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_listing_session_items_session
         ON listing_session_items(session_id);`,
      );
      // v8 那张「一个 URL 一行」的 listing_items 只保留最后一次，把还能认出来的
      // 会话搬过来（表本身先留着，不删，按 §4 的约定）。
      await db.execute(
        `INSERT OR IGNORE INTO listing_sessions (id, site, pages, total, created_at)
         SELECT session_id, MAX(site), '', COUNT(*), MAX(last_seen_at)
           FROM listing_items WHERE session_id > 0 GROUP BY session_id;`,
      );
      await db.execute(
        `INSERT OR IGNORE INTO listing_session_items
           (session_id, url, title, preview, selected)
         SELECT session_id, url, title, preview, selected
           FROM listing_items WHERE session_id > 0;`,
      );
    },
  },
  {
    version: 10,
    description:
      'image_favorites 表（App 内图片收藏，不再写系统相册）+ history.title_plain（标题搜索兼容 HTML 实体）',
    up: async db => {
      // App 内图片收藏：一行一张图，uri 用 MediaStore 的 content:// 地址
      // （与 history.image_paths 里存的是同一个标识，便于反查记录）。
      await db.execute(
        `CREATE TABLE IF NOT EXISTS image_favorites (
          uri TEXT PRIMARY KEY NOT NULL,
          record_id INTEGER NOT NULL DEFAULT 0,
          url TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT 0
        );`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_image_favorites_created
         ON image_favorites(created_at DESC);`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_image_favorites_record
         ON image_favorites(record_id);`,
      );

      // 标题搜索用的「已解码」副本：老记录的标题里存着 `&#8211;` 这类 HTML
      // 实体，界面上显示的是解码后的文字，用户照着显示的文字搜索就会搜不到。
      // 旧数据默认空串，下面一次性回填（AGENTS.md §4）。
      await db.execute(
        `ALTER TABLE history ADD COLUMN title_plain TEXT NOT NULL DEFAULT '';`,
      );
      const res = await db.execute(
        `SELECT id, title FROM history WHERE title LIKE '%&%';`,
      );
      for (const row of (res.rows ?? []) as Array<Record<string, unknown>>) {
        const decoded = decodeHtmlEntities(String(row.title ?? ''));
        if (decoded === String(row.title ?? '')) continue;
        await db.execute(`UPDATE history SET title_plain = ? WHERE id = ?;`, [
          decoded,
          Number(row.id),
        ]);
      }
      // 没有实体的记录（绝大多数）解码后与原值相同，直接复制一份。
      await db.execute(
        `UPDATE history SET title_plain = title WHERE title_plain = '';`,
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
  const tags = JSON.stringify(input.tags ?? []);
  await d.execute(
    `INSERT INTO history
       (url, title, title_plain, image_count, success_count, failed_count, skipped_count,
        save_dir, status, image_urls, image_paths, save_paths,
        created_at, updated_at, tags, tags_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       title_plain = excluded.title_plain,
       image_count = excluded.image_count,
       success_count = excluded.success_count,
       failed_count = excluded.failed_count,
       skipped_count = excluded.skipped_count,
       save_dir = excluded.save_dir,
       status = excluded.status,
       image_urls = CASE WHEN excluded.image_urls = '[]' THEN history.image_urls ELSE excluded.image_urls END,
       image_paths = CASE WHEN excluded.image_paths = '[]' THEN history.image_paths ELSE excluded.image_paths END,
       save_paths = CASE WHEN excluded.save_paths = '[]' THEN history.save_paths ELSE excluded.save_paths END,
       tags = CASE WHEN excluded.tags = '[]' THEN history.tags ELSE excluded.tags END,
       tags_checked_at = CASE WHEN excluded.tags = '[]' THEN history.tags_checked_at ELSE excluded.tags_checked_at END,
       updated_at = excluded.updated_at;`,
    [
      input.url,
      input.title,
      decodeHtmlEntities(input.title),
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
      tags,
      // 刚解析过的页面等于「已经看过标签」，补全任务不该再把这条抓一遍。
      // 解析阶段本来就没抓到（telegra.ph / 静态站返回空）也算看过了。
      now,
    ],
  );
  // 重新下载成功 = 这条不再算「被删过」，清掉墓碑。
  try {
    await d.execute('DELETE FROM deleted_urls WHERE url = ?;', [input.url]);
  } catch {
    // best-effort
  }
  markHistoryChanged();
}

/** 一条「缺标签」的候选记录（补全标签任务用）。 */
export type TagBackfillTarget = {
  id: number;
  url: string;
  title: string;
};

/**
 * 列出「网页记录里还没有标签」的那些，按站点聚在一起，便于补全任务
 * 对同一主机连续请求（并发会被站点限流，见 everiaListing 的教训）。
 */
export async function listHistoryNeedingTags(): Promise<TagBackfillTarget[]> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT id, url, title FROM history
      WHERE tags = '[]' AND tags_checked_at = 0 AND url LIKE 'http%'
      ORDER BY LOWER(url) ASC, id ASC;`,
  );
  const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: Number(r.id),
    url: String(r.url),
    title: String(r.title ?? ''),
  }));
}

/** 待补标签的条数（设置页显示用，不加载明细）。 */
export async function countHistoryNeedingTags(): Promise<number> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT COUNT(1) AS n FROM history
      WHERE tags = '[]' AND tags_checked_at = 0 AND url LIKE 'http%';`,
  );
  const row = (res.rows?.[0] ?? {}) as Record<string, unknown>;
  return Number(row.n ?? 0);
}

/**
 * 写入某条记录的标签，并记下「这条已经看过标签」（`tags_checked_at`）。
 * `onlyIfEmpty` 为真时只更新还没有标签的记录，保证补全任务不会覆盖已有结果。
 */
export async function updateHistoryTags(
  id: number,
  tags: string[],
  options: { onlyIfEmpty?: boolean } = {},
): Promise<void> {
  await initHistoryDatabase();
  const payload = JSON.stringify(tags);
  const now = Date.now();
  await getDb().execute(
    options.onlyIfEmpty
      ? `UPDATE history SET tags = ?, tags_checked_at = ?, updated_at = ?
          WHERE id = ? AND tags = '[]';`
      : `UPDATE history SET tags = ?, tags_checked_at = ?, updated_at = ?
          WHERE id = ?;`,
    [payload, now, now, id],
  );
  markHistoryChanged();
}

/**
 * 查这些网址是否「以前下载过、后来被删了」。
 * 返回 Map<url, deleted_at>；没删过的不在 Map 里。
 */
export async function listDeletedUrlInfo(
  urls: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = Array.from(new Set(urls.filter(u => /^https?:\/\//i.test(u))));
  if (unique.length === 0) return out;
  await initHistoryDatabase();
  const d = getDb();
  // SQLite 的变量数有上限，分批查。
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const placeholders = part.map(() => '?').join(',');
    const res = await d.execute(
      `SELECT url, deleted_at FROM deleted_urls WHERE url IN (${placeholders});`,
      part,
    );
    for (const r of (res.rows ?? []) as Array<Record<string, unknown>>) {
      out.set(String(r.url), Number(r.deleted_at ?? 0));
    }
  }
  return out;
}

/** 在线图集里一条候选的落库形态。 */
export type ListingItemRecord = {
  url: string;
  title: string;
  preview: string;
  /** 上次「加入待下载」时是否勾选了它。 */
  selected: boolean;
};

/**
 * 保存一次抓取的完整快照。**每场会话各存一份**，互不覆盖 —— 这样用户可以从
 * 历史里挑任意一次抓取结果重新打开（`listing_sessions` + `listing_session_items`）。
 */
export async function saveListingSession(
  site: string,
  sessionId: number,
  meta: { pages: string; total: number },
  entries: Array<{ url: string; title: string; preview: string }>,
): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  const now = Date.now();
  await d.execute(
    `INSERT INTO listing_sessions (id, site, pages, total, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pages = excluded.pages,
       total = excluded.total;`,
    [sessionId, site, meta.pages, meta.total, now],
  );
  for (const e of entries) {
    await d.execute(
      `INSERT INTO listing_session_items (session_id, url, title, preview, selected)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(session_id, url) DO UPDATE SET
         title = excluded.title,
         preview = excluded.preview;`,
      [sessionId, e.url, e.title, e.preview],
    );
  }
}

/** 一次抓取的元信息（历史选择列表用）。 */
export type ListingSessionSummary = {
  sessionId: number;
  createdAt: number;
  /** 抓了哪些页，例如 `1,2,3,4,5`。 */
  pages: string;
  /** 本次抓到的总条数（去重前）。 */
  total: number;
  /** 本次会话里勾了多少条。 */
  selectedCount: number;
};

/** 历史抓取记录（新的在前）。 */
export async function listListingSessions(
  site: string,
  limit = 30,
): Promise<ListingSessionSummary[]> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT s.id, s.created_at, s.pages, s.total,
            (SELECT COUNT(*) FROM listing_session_items i
              WHERE i.session_id = s.id AND i.selected = 1) AS sel
       FROM listing_sessions s
      WHERE s.site = ?
      ORDER BY s.id DESC
      LIMIT ?;`,
    [site, limit],
  );
  return ((res.rows ?? []) as Array<Record<string, unknown>>).map(r => ({
    sessionId: Number(r.id),
    createdAt: Number(r.created_at ?? 0),
    pages: String(r.pages ?? ''),
    total: Number(r.total ?? 0),
    selectedCount: Number(r.sel ?? 0),
  }));
}

/**
 * 上一场抓取里这些 URL 的勾选状态（用于「上次未入选」）。
 * 只看**紧邻的上一场**会话，避免把更早的结果混进来。
 */
export async function listPreviousListingSelection(
  site: string,
  currentSessionId: number,
): Promise<Map<string, boolean>> {
  await initHistoryDatabase();
  const d = getDb();
  const head = await d.execute(
    `SELECT MAX(id) AS s FROM listing_sessions WHERE site = ? AND id < ?;`,
    [site, currentSessionId],
  );
  const prevId = Number(
    ((head.rows?.[0] ?? {}) as Record<string, unknown>).s ?? 0,
  );
  const out = new Map<string, boolean>();
  if (!prevId) return out;
  const res = await d.execute(
    `SELECT url, selected FROM listing_session_items WHERE session_id = ?;`,
    [prevId],
  );
  for (const r of (res.rows ?? []) as Array<Record<string, unknown>>) {
    out.set(String(r.url), Number(r.selected ?? 0) === 1);
  }
  return out;
}

/** 记住某场会话「加入待下载」勾了哪些（没勾的记为 0）。 */
export async function markListingSelection(
  sessionId: number,
  selectedUrls: string[],
): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute(
    `UPDATE listing_session_items SET selected = 0 WHERE session_id = ?;`,
    [sessionId],
  );
  const unique = Array.from(new Set(selectedUrls));
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const placeholders = part.map(() => '?').join(',');
    await d.execute(
      `UPDATE listing_session_items SET selected = 1 WHERE session_id = ? AND url IN (${placeholders});`,
      [sessionId, ...part],
    );
  }
}

/** 读回某一场抓取的候选（不联网）。返回 null 表示这场不存在。 */
export async function loadListingSession(sessionId: number): Promise<{
  sessionId: number;
  pages: string;
  total: number;
  items: ListingItemRecord[];
} | null> {
  await initHistoryDatabase();
  const d = getDb();
  const head = await d.execute(
    `SELECT pages, total FROM listing_sessions WHERE id = ?;`,
    [sessionId],
  );
  const row = (head.rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const res = await d.execute(
    `SELECT url, title, preview, selected FROM listing_session_items
      WHERE session_id = ?
      ORDER BY rowid ASC;`,
    [sessionId],
  );
  const items = ((res.rows ?? []) as Array<Record<string, unknown>>).map(r => ({
    url: String(r.url),
    title: String(r.title ?? ''),
    preview: String(r.preview ?? ''),
    selected: Number(r.selected ?? 0) === 1,
  }));
  return {
    sessionId,
    pages: String(row.pages ?? ''),
    total: Number(row.total ?? items.length),
    items,
  };
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
    `SELECT ${HISTORY_COLUMNS}
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
  /** Exact match on the derived run status (done / partial / failed / cancelled). */
  status?: HistoryStatus;
  /** 只看收藏（收藏页 / 收藏筛选）。 */
  favoriteOnly?: boolean;
  /** 只看「标记为删除」（尚未移入回收站）的记录。 */
  markedDeletedOnly?: boolean;
  /** 只看带这个标签的记录（详情页点标签 → 标签列表）。 */
  tag?: string;
}

/**
 * Turn a {@link HistoryListFilter} into a reusable SQL WHERE clause + params.
 * The caller owns the placeholders, so this helper returns only the WHERE
 * text and bound params (no LIMIT/OFFSET).
 *
 * 回收站里的记录（trashed_at > 0）**永远**不会出现在这里：下载记录列表、计数、
 * 收藏页都走这个过滤器；回收站用自己的查询（{@link listTrash}）。
 */
function buildHistoryFilter(filter?: HistoryListFilter): {
  whereSql: string;
  params: Scalar[];
} {
  const clauses: string[] = ['trashed_at = 0'];
  const params: Scalar[] = [];
  if (!filter) return { whereSql: `WHERE ${clauses[0]}`, params };
  const title = filter.title?.trim();
  if (title) {
    // 同时查原始值与解码后的副本：老记录的标题里存着 `&#8211;` 这类实体，
    // 界面上显示的却是解码后的文字（`–`），只查原始列会「照着看到的搜不到」。
    // ESCAPE 必须有：没有它，`%` / `_` 会被当成通配符。
    const pattern = likeContainsPattern(title);
    clauses.push(
      `(title LIKE ? ESCAPE '\\' OR title_plain LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern);
  }
  if (filter.createdAfterMs != null) {
    clauses.push('created_at >= ?');
    params.push(filter.createdAfterMs);
  }
  if (filter.createdBeforeMs != null) {
    clauses.push('created_at < ?');
    params.push(filter.createdBeforeMs);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.favoriteOnly) clauses.push('is_favorite = 1');
  if (filter.markedDeletedOnly) clauses.push('is_marked_deleted = 1');
  if (filter.tag) {
    // tags 是 JSON 数组字符串；带引号匹配，避免 `cat` 命中 `catsuit`。
    clauses.push('instr(tags, ?) > 0');
    params.push(tagJsonFragment(filter.tag));
  }
  return {
    whereSql: `WHERE ${clauses.join(' AND ')}`,
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
     WHERE created_at >= ? AND created_at < ? AND trashed_at = 0;`,
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
    `SELECT ${HISTORY_COLUMNS}
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
    `SELECT ${HISTORY_COLUMNS}
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
      `SELECT ${HISTORY_COLUMNS}
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
/**
 * Persist a manual re-ordering of one record's images.
 *
 * `order[i]` is the index (into the stored arrays) of the image that should end
 * up at display position `i`. All three per-image arrays are permuted together
 * so `image_paths[i]` keeps matching `image_urls[i]` / `save_paths[i]` — the
 * detail grid relies on that alignment for its remote retry fallback.
 *
 * The arrays are stored as JSON text, so this needs no schema migration.
 */
export async function reorderHistoryImages(
  id: number,
  order: number[],
): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  const res = await d.execute(
    `SELECT image_urls, image_paths, save_paths FROM history WHERE id = ? LIMIT 1;`,
    [id],
  );
  const row = (res.rows ?? [])[0];
  if (!row || order.length === 0) return;

  const permute = (value: unknown): string => {
    const arr = decodeJsonArray(value);
    // A malformed order (or a row whose arrays disagree in length) must never
    // drop entries — keep the stored order in that case.
    if (arr.length !== order.length) return JSON.stringify(arr);
    const next = order.map(i => arr[i]);
    return JSON.stringify(next.every(v => typeof v === 'string') ? next : arr);
  };

  await d.execute(
    `UPDATE history
        SET image_urls = ?, image_paths = ?, save_paths = ?, updated_at = ?
      WHERE id = ?;`,
    [
      permute(row.image_urls),
      permute(row.image_paths),
      permute(row.save_paths),
      Date.now(),
      id,
    ],
  );
  markHistoryChanged();
}

export async function removeHistory(id: number): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute('DELETE FROM history WHERE id = ?;', [id]);
  markHistoryChanged();
}

/* ------------------------------------------------------------------ */
/* 收藏 / 标记删除 / 回收站（v5）                                       */
/* ------------------------------------------------------------------ */

/** 收藏或取消收藏一条记录。 */
export async function setHistoryFavorite(
  id: number,
  favorite: boolean,
): Promise<void> {
  await initHistoryDatabase();
  await getDb().execute(
    `UPDATE history SET is_favorite = ?, updated_at = ? WHERE id = ?;`,
    [favorite ? 1 : 0, Date.now(), id],
  );
  markHistoryChanged();
}

/**
 * 指定某张图片为图集封面（列表 / 回收站的缩略图优先用它）。
 * 传空串 = 清除自定义封面，退回第一张。
 */
export async function setHistoryCover(
  id: number,
  coverUri: string,
): Promise<void> {
  await initHistoryDatabase();
  await getDb().execute(
    `UPDATE history SET cover_uri = ?, updated_at = ? WHERE id = ?;`,
    [coverUri, Date.now(), id],
  );
  markHistoryChanged();
}

/* ------------------------------------------------------------------ */
/* App 内图片收藏（v10）                                                */
/* ------------------------------------------------------------------ */

/**
 * 一张「App 内收藏」的图片。
 *
 * 和系统相册收藏（`MediaStore.IS_FAVORITE`）是两套独立的东西：
 * 系统那套会写进手机相册的收藏夹，用户收藏多了相册会变得很乱；
 * 这一套只存在本 App 的库里，删掉 App 数据才会丢。
 */
export interface FavoriteImage {
  /** MediaStore content:// URI（与 history.image_paths 里的标识一致）。 */
  uri: string;
  /** 所属下载记录 id；0 = 找不到来源记录（例如记录已删除）。 */
  recordId: number;
  /** 图片的源地址（远程兜底用，可为空）。 */
  url: string;
  /** 收藏时间（UTC ms）。 */
  createdAt: number;
  /** 所属记录的标题；记录已删除时为空串。 */
  title: string;
}

/** 收藏 / 取消收藏一张图片（App 内）。 */
export async function setImageFavorite(
  uri: string,
  favorite: boolean,
  owner?: { recordId?: number; url?: string },
): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  if (!favorite) {
    await d.execute('DELETE FROM image_favorites WHERE uri = ?;', [uri]);
    return;
  }
  await d.execute(
    `INSERT INTO image_favorites (uri, record_id, url, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       record_id = excluded.record_id,
       url = CASE WHEN excluded.url = '' THEN image_favorites.url ELSE excluded.url END;`,
    [uri, owner?.recordId ?? 0, owner?.url ?? '', Date.now()],
  );
}

/** 查询一张图片是否已在本 App 里收藏。 */

/**
 * 批量筛出「已在本 App 收藏」的 URI（详情页宫格打 ♥ 角标用）。
 * 按 400 一批，避开 SQLite 的绑定变量上限。
 */
export async function listImageFavoriteUris(
  uris: string[],
): Promise<string[]> {
  if (uris.length === 0) return [];
  await initHistoryDatabase();
  const d = getDb();
  const out: string[] = [];
  for (let i = 0; i < uris.length; i += 400) {
    const chunk = uris.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const res = await d.execute(
      `SELECT uri FROM image_favorites WHERE uri IN (${placeholders});`,
      chunk,
    );
    for (const row of (res.rows ?? []) as Array<Record<string, unknown>>) {
      out.push(String(row.uri));
    }
  }
  return out;
}

/** 全部 App 内收藏的图片（新的在前），带上所属记录的标题。 */
export async function listFavoriteImages(): Promise<FavoriteImage[]> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT f.uri, f.record_id, f.url, f.created_at,
            COALESCE(h.title, '') AS title
       FROM image_favorites f
       LEFT JOIN history h ON h.id = f.record_id
      ORDER BY f.created_at DESC;`,
  );
  return ((res.rows ?? []) as Array<Record<string, unknown>>).map(row => ({
    uri: String(row.uri),
    recordId: Number(row.record_id ?? 0),
    url: String(row.url ?? ''),
    createdAt: Number(row.created_at ?? 0),
    title: String(row.title ?? ''),
  }));
}

/** App 内收藏的图片总数。 */
export async function countFavoriteImages(): Promise<number> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    'SELECT COUNT(*) AS n FROM image_favorites;',
  );
  const row = (res.rows ?? [])[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 把一批「系统相册收藏」的 URI 一次性导入 App 收藏（只增不改）。
 *
 * 一次性动作：老用户以前用 ♥ 收藏的图片都写在系统里，直接切到 App 收藏会
 * 让新界面空空如也。这里按 `image_paths` 反查所属记录，查不到就用 0。
 * 返回**新增**的条数（已在库里的不重复计数）。
 */
export async function importImageFavorites(uris: string[]): Promise<number> {
  if (uris.length === 0) return 0;
  await initHistoryDatabase();
  const d = getDb();
  const before = await countFavoriteImages();

  // 一次读出所有记录的文件名单，建立 uri → 记录 的索引（避免逐条 LIKE 扫库）。
  const owners = new Map<string, { recordId: number; url: string }>();
  const res = await d.execute('SELECT id, image_paths, image_urls FROM history;');
  for (const row of (res.rows ?? []) as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    const paths = parseStringArray(row.image_paths);
    const urls = parseStringArray(row.image_urls);
    for (let i = 0; i < paths.length; i += 1) {
      if (!owners.has(paths[i]!)) {
        owners.set(paths[i]!, { recordId: id, url: urls[i] ?? '' });
      }
    }
  }

  const now = Date.now();
  for (const uri of uris) {
    const owner = owners.get(uri);
    await d.execute(
      `INSERT OR IGNORE INTO image_favorites (uri, record_id, url, created_at)
       VALUES (?, ?, ?, ?);`,
      [uri, owner?.recordId ?? 0, owner?.url ?? '', now],
    );
  }
  return (await countFavoriteImages()) - before;
}

/** JSON 数组列 → string[]（坏数据退化成空数组，不让列表整页挂掉）。 */
function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 标记为删除 / 取消标记（只是打标记，记录仍在下载记录里）。 */
export async function setHistoryMarkedDeleted(
  id: number,
  marked: boolean,
): Promise<void> {
  await initHistoryDatabase();
  await getDb().execute(
    `UPDATE history SET is_marked_deleted = ?, updated_at = ? WHERE id = ?;`,
    [marked ? 1 : 0, Date.now(), id],
  );
  markHistoryChanged();
}

/** 「标记为删除」且尚未进回收站的条数（列表按钮的角标）。 */
export async function countMarkedDeleted(): Promise<number> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT COUNT(*) AS n FROM history
      WHERE is_marked_deleted = 1 AND trashed_at = 0;`,
  );
  const row = (res.rows ?? [])[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 回收站容量上限。
 *
 * 超过后不再接收新的记录：回收站列表本身按这个上限取数，如果放任无限堆积，
 * 用户会看到一个「被静默截断」的列表，而且清空时也会漏掉超出的部分。
 */
export const TRASH_CAPACITY = 500;

/** {@link moveMarkedToTrash} 的结果。 */
export interface TrashMoveResult {
  /** 真正移入回收站的条数。 */
  moved: number;
  /** 因回收站已满被拒绝的条数（仍留在下载记录里，标记保持）。 */
  skipped: number;
}

/**
 * 一键把「标记为删除」的记录移入回收站。
 * 移入后从下载记录里消失，但数据仍在（回收站可恢复或彻底清空）。
 * **保留 `is_marked_deleted`**：还原回来时删除标记还在（用户要求）。
 * 回收站达到 {@link TRASH_CAPACITY} 时只移入剩余名额，其余原样保留。
 */
export async function moveMarkedToTrash(): Promise<TrashMoveResult> {
  await initHistoryDatabase();
  const count = await countMarkedDeleted();
  if (count === 0) return { moved: 0, skipped: 0 };
  const trashed = await countTrash();
  const room = Math.max(0, TRASH_CAPACITY - trashed);
  if (room === 0) return { moved: 0, skipped: count };
  const now = Date.now();
  await getDb().execute(
    `UPDATE history
        SET trashed_at = ?, updated_at = ?
      WHERE id IN (
        SELECT id FROM history
         WHERE is_marked_deleted = 1 AND trashed_at = 0
         ORDER BY created_at DESC
         LIMIT ?
      );`,
    [now, now, room],
  );
  markHistoryChanged();
  const moved = Math.min(room, count);
  return { moved, skipped: count - moved };
}

/** 回收站列表（按移入时间倒序）。 */
export async function listTrash(
  limit = 100,
  offset = 0,
): Promise<HistoryRecord[]> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT ${HISTORY_COLUMNS}
       FROM history
      WHERE trashed_at > 0
      ORDER BY trashed_at DESC
      LIMIT ? OFFSET ?;`,
    [limit, Math.max(0, offset)],
  );
  return (res.rows ?? []).map(rowToRecord);
}

/** 回收站条数。 */
export async function countTrash(): Promise<number> {
  await initHistoryDatabase();
  const res = await getDb().execute(
    `SELECT COUNT(*) AS n FROM history WHERE trashed_at > 0;`,
  );
  const row = (res.rows ?? [])[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** 从回收站恢复（回到下载记录列表）。**保留「标记为删除」的状态** —— 还原只是
 * 撤销「移入回收站」这一步，用户之前打的删除意图还在，列表里仍会显示待删除徽章。 */
export async function restoreFromTrash(id: number): Promise<void> {
  await initHistoryDatabase();
  await getDb().execute(
    `UPDATE history
        SET trashed_at = 0, updated_at = ?
      WHERE id = ?;`,
    [Date.now(), id],
  );
  markHistoryChanged();
}

/** 该记录里可删除的本地图片 URI（清空回收站时用来删文件）。 */
export function recordImageUris(record: HistoryRecord): string[] {
  return (record.imagePaths ?? []).filter(
    u => u.startsWith('content://') || u.startsWith('file://'),
  );
}

/** 彻底删除若干条记录（不碰文件；文件由调用方先删）。 */
export async function purgeHistory(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await initHistoryDatabase();
  const d = getDb();
  const placeholders = ids.map(() => '?').join(',');
  // 删之前先给「网页类」记录留个墓碑：在线图集/批量列表据此提示
  // 「这条以前下过、后来删了」。archive:// 没有可复用的地址，跳过。
  try {
    const rows = await d.execute(
      `SELECT url, title FROM history WHERE id IN (${placeholders});`,
      ids,
    );
    const now = Date.now();
    for (const r of (rows.rows ?? []) as Array<Record<string, unknown>>) {
      const url = String(r.url ?? '');
      if (!/^https?:\/\//i.test(url)) continue;
      await d.execute(
        `INSERT INTO deleted_urls (url, title, deleted_at) VALUES (?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           deleted_at = excluded.deleted_at;`,
        [url, String(r.title ?? ''), now],
      );
    }
  } catch {
    // 墓碑只是辅助提示，写失败不能挡住真正的删除。
  }
  await d.execute(
    `DELETE FROM history WHERE id IN (${placeholders});`,
    ids,
  );
  markHistoryChanged();
}

/**
 * Drop ledger rows for the given source image URLs.
 *
 * Called when the user deletes a record *together with its images*: the ledger
 * is what makes a later re-download skip URLs it has already saved, so leaving
 * stale rows behind would make the next run skip every image of a record whose
 * files no longer exist.
 */
export async function removeDownloadedImages(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await initHistoryDatabase();
  const d = getDb();
  for (const url of urls) {
    try {
      await d.execute('DELETE FROM downloaded_images WHERE url = ?;', [url]);
    } catch {
      // Best-effort: a failed ledger cleanup only risks a future "skip".
    }
  }
}

/** Clear all history (does NOT touch downloaded files). */
export async function clearHistory(): Promise<void> {
  await initHistoryDatabase();
  const d = getDb();
  await d.execute('DELETE FROM history;');
}

/* ------------------------------------------------------------------ */
/* Cross-screen "history changed" flag                                 */
/* ------------------------------------------------------------------ */

/**
 * Set whenever history rows change, so a list screen can refresh the next time
 * it regains focus — after a download finishes in another tab, or after a
 * delete on the detail page — without reloading on every tab switch.
 */
let historyChanged = false;

/** Record that history rows changed. */
export function markHistoryChanged(): void {
  historyChanged = true;
}

/** True exactly once after a change; clears the flag. */
export function consumeHistoryChanged(): boolean {
  const changed = historyChanged;
  historyChanged = false;
  return changed;
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
    isFavorite: Number(row.is_favorite ?? 0) === 1,
    isMarkedDeleted: Number(row.is_marked_deleted ?? 0) === 1,
    trashedAt: Number(row.trashed_at ?? 0),
    coverUri: String(row.cover_uri ?? ''),
    tags: decodeJsonArray(row.tags),
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
    tags: article.tags,
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
