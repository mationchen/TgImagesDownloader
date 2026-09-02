import {
  computeSubfolder,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  _resetSettingsCacheForTests,
  type AppSettings,
} from '../src/services/settingsService';
import {buildFilename} from '../src/services/imageDownloader';
import {open} from '@op-engineering/op-sqlite';

// Minimal fake DB: historyService reads/writes the settings KV via getDb().
const fakeStore: Record<string, Record<string, unknown>[]> = {
  settings: [],
  schema_meta: [],
  history: [],
};

const fakeDb = {
  execute: async (sql: string, params?: any[]) => {
    const setv = sql.match(/INSERT OR REPLACE INTO settings/i);
    if (setv) {
      const [key, value, updated_at] = params ?? [];
      const arr = fakeStore.settings;
      const idx = arr.findIndex(r => r.key === key);
      const entry = {key, value, updated_at};
      if (idx >= 0) arr[idx] = entry;
      else arr.push(entry);
      return {rows: [], insertId: arr.length, rowsAffected: 1};
    }
    const getv = sql.match(/SELECT value FROM settings WHERE key = ?/i);
    if (getv) {
      const [key] = params ?? [];
      const arr = fakeStore.settings;
      const row = arr.find(r => r.key === key);
      return {rows: row ? [row] : [], insertId: 0, rowsAffected: row ? 1 : 0};
    }
    const delv = sql.match(/DELETE FROM settings WHERE key = ?/i);
    if (delv) {
      const [key] = params ?? [];
      fakeStore.settings = fakeStore.settings.filter(r => r.key !== key);
      return {rows: [], insertId: 0, rowsAffected: 1};
    }
    // Pass through anything else (PRAGMA, schema_meta, history, etc.).
    return {rows: [], insertId: 0, rowsAffected: 0};
  },
  executeSync: (sql: string, params?: any[]) =>
    // synchronous mirrors of the same handlers (used by runMigrations etc.)
    fakeDb.execute(sql, params),
  executeAsync: (sql: string, params?: any[]) =>
    fakeDb.execute(sql, params),
  transaction: async (fn: any) => {
    await fn({execute: fakeDb.execute});
  },
  close: async () => undefined,
} as any;

beforeEach(() => {
  fakeStore.settings = [];
  fakeStore.schema_meta = [];
  fakeStore.history = [];
  _resetSettingsCacheForTests();
  (open as unknown as jest.Mock).mockReturnValue(fakeDb);
});

describe('settingsService', () => {
  describe('computeSubfolder', () => {
    const article = {title: 'My Article', url: 'https://example.com/foo'};

    it('uses the article title by default', () => {
      expect(computeSubfolder(article, DEFAULT_SETTINGS)).toBe('My Article');
    });

    it('uses the source domain when template = domain', () => {
      const s: AppSettings = {
        ...DEFAULT_SETTINGS,
        subfolderTemplate: 'domain',
      };
      expect(computeSubfolder(article, s)).toBe('example.com');
    });

    it('falls back to title when domain cannot be parsed', () => {
      const s: AppSettings = {
        ...DEFAULT_SETTINGS,
        subfolderTemplate: 'domain',
      };
      expect(computeSubfolder({title: 'X', url: 'not a url'}, s)).toBe('X');
    });

    it('uses custom value when template = custom', () => {
      const s: AppSettings = {
        ...DEFAULT_SETTINGS,
        subfolderTemplate: 'custom',
        subfolderCustom: 'MyStuff',
      };
      expect(computeSubfolder(article, s)).toBe('MyStuff');
    });

    it('falls back to title when custom value is empty', () => {
      const s: AppSettings = {
        ...DEFAULT_SETTINGS,
        subfolderTemplate: 'custom',
        subfolderCustom: '   ',
      };
      expect(computeSubfolder(article, s)).toBe('My Article');
    });
  });

  describe('loadSettings / saveSettings', () => {
    it('returns defaults when nothing is stored', async () => {
      const s = await loadSettings();
      expect(s).toEqual(DEFAULT_SETTINGS);
    });

    it('roundtrips a non-default settings object', async () => {
      const next: AppSettings = {
        subfolderTemplate: 'domain',
        subfolderCustom: 'ignored-when-not-custom',
        namingRule: 'title',
        autoFillClipboard: false,
        storageType: 'downloads',
        customTreeUri: 'content://test/tree',
      };
      await saveSettings(next);
      const loaded = await loadSettings();
      expect(loaded).toEqual(next);
    });

    it('returns defaults when stored JSON is corrupt', async () => {
      fakeStore.settings.push({
        key: 'app_settings_v1',
        value: '{not valid json',
        updated_at: 0,
      });
      const s = await loadSettings();
      expect(s).toEqual(DEFAULT_SETTINGS);
    });

    it('clamps unknown enum values back to defaults', async () => {
      fakeStore.settings.push({
        key: 'app_settings_v1',
        value: JSON.stringify({
          subfolderTemplate: 'bogus',
          subfolderCustom: 12345, // wrong type
          namingRule: 'whatever',
          autoFillClipboard: 'maybe',
          storageType: 'bogus',
          customTreeUri: 99,
        }),
        updated_at: 0,
      });
      const s = await loadSettings();
      expect(s.subfolderTemplate).toBe('title');
      expect(s.subfolderCustom).toBe('');
      expect(s.namingRule).toBe('date_index');
      expect(s.autoFillClipboard).toBe(true);
      expect(s.storageType).toBe('pictures');
      expect(s.customTreeUri).toBe('');
    });
  });

  describe('buildFilename', () => {
    const baseImage = (overrides: Partial<{index: number; filename: string; url: string}> = {}) => ({
      id: 'x',
      index: 1,
      url: 'https://example.com/photo.jpg',
      filename: '001.jpg',
      selected: true,
      ...overrides,
    });

    it('uses zero-padded 6-digit index for the date_index rule', () => {
      const s: AppSettings = {...DEFAULT_SETTINGS, namingRule: 'date_index'};
      const name = buildFilename(baseImage({index: 7}), undefined, s);
      expect(name).toMatch(/^\d{8}_000007$/);
    });

    it('appends the article title short-tag for the title rule', () => {
      const s: AppSettings = {...DEFAULT_SETTINGS, namingRule: 'title'};
      const name = buildFilename(
        baseImage({index: 12}),
        'My Album',
        s,
      );
      expect(name).toMatch(/^000012_/);
    });

    it('uses the URL basename for the original rule', () => {
      const s: AppSettings = {...DEFAULT_SETTINGS, namingRule: 'original'};
      const name = buildFilename(
        baseImage({url: 'https://cdn.example.com/path/photo.jpg?x=1'}),
        undefined,
        s,
      );
      expect(name).toBe('photo');
    });

    it('falls back to index when the URL cannot be parsed', () => {
      const s: AppSettings = {...DEFAULT_SETTINGS, namingRule: 'original'};
      const name = buildFilename(
        baseImage({url: 'not a url', index: 5}),
        undefined,
        s,
      );
      expect(name).toBe('5');
    });
  });
});