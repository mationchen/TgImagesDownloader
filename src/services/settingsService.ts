import { getSetting, setSetting } from './historyService';
import { sanitizeFilename } from '../utils/filename';
import { APP_CONFIG, type SupportedLocale } from '../constants/config';

export type SubfolderTemplate = 'title' | 'domain' | 'custom';
export type NamingRule = 'date_index' | 'original' | 'title';

/** How the app resolves light/dark: follow the system, or force one. */
export type AppThemeMode = 'system' | 'light' | 'dark';

/**
 * Where saved images live on Android:
 *   - 'pictures':      MediaStore.Images in Pictures/TelegraphDownloader/<sub>/  (default)
 *   - 'downloads':     MediaStore.Downloads in Download/TelegraphDownloader/<sub>/
 *   - 'custom':        User picks an arbitrary RELATIVE_PATH under the Pictures tree
 *                      via SAF ACTION_OPEN_DOCUMENT_TREE (Android only).
 */
export type StorageType = 'pictures' | 'downloads' | 'custom';

/** Sentinel app folder the app creates and writes to inside the user-picked SAF tree. */
export const APP_FOLDER_NAME = 'TelegraphDownloader';

export interface AppSettings {
  /** How to derive the per-batch MediaStore subfolder. */
  subfolderTemplate: SubfolderTemplate;
  /** Custom subfolder used when subfolderTemplate === 'custom'. */
  subfolderCustom: string;
  /** How to name each downloaded image file (basename, no extension). */
  namingRule: NamingRule;
  /** Whether to auto-fill the URL field from clipboard on Home screen focus. */
  autoFillClipboard: boolean;
  /** Storage location on Android. */
  storageType: StorageType;
  /**
   * Persistable URI string of the SAF tree picked by the user (when
   * storageType === 'custom'). Empty when not yet picked.
   */
  customTreeUri: string;
  /** UI language. Defaults to the app-wide default locale (zh-CN). */
  locale: SupportedLocale;
  /** Light/Dark resolution. Defaults to following the system. */
  theme: AppThemeMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  subfolderTemplate: 'title',
  subfolderCustom: '',
  namingRule: 'date_index',
  autoFillClipboard: true,
  storageType: 'pictures',
  customTreeUri: '',
  locale: APP_CONFIG.i18n.defaultLocale,
  theme: 'system',
};

const SETTINGS_KEY = 'app_settings_v1';

/**
 * Compute the MediaStore subfolder for a given article, honouring the
 * user's subfolder-template preference (title / domain / custom).
 */
export function computeSubfolder(
  article: { title: string; url: string },
  settings: AppSettings,
): string {
  let raw: string;
  switch (settings.subfolderTemplate) {
    case 'domain':
      try {
        raw = new URL(article.url).hostname;
      } catch {
        raw = article.title;
      }
      break;
    case 'custom':
      raw = settings.subfolderCustom.trim() || article.title;
      break;
    case 'title':
    default:
      raw = article.title;
      break;
  }
  return sanitizeFilename(raw, 80) || 'untitled';
}

/** Build the full RELATIVE_PATH (under MediaStore) for a given article. */
export function computeRelativePath(
  article: { title: string; url: string },
  settings: AppSettings,
): string {
  const subfolder = computeSubfolder(article, settings);
  const root = settings.storageType === 'downloads' ? 'Download' : 'Pictures';
  return `${root}/${APP_FOLDER_NAME}/${subfolder}`;
}

/** Compute the default fixed top-level directory under MediaStore. */
export function computeBaseRelativePath(settings: AppSettings): string {
  const root = settings.storageType === 'downloads' ? 'Download' : 'Pictures';
  return `${root}/${APP_FOLDER_NAME}`;
}

/** Module-level cache so reads don't touch SQLite on every access. */
let cache: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const raw = await getSetting(SETTINGS_KEY);
  if (!raw) {
    cache = DEFAULT_SETTINGS;
    return cache;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = {
      subfolderTemplate:
        parsed.subfolderTemplate === 'custom' ||
        parsed.subfolderTemplate === 'domain' ||
        parsed.subfolderTemplate === 'title'
          ? parsed.subfolderTemplate
          : DEFAULT_SETTINGS.subfolderTemplate,
      subfolderCustom:
        typeof parsed.subfolderCustom === 'string'
          ? parsed.subfolderCustom
          : DEFAULT_SETTINGS.subfolderCustom,
      namingRule:
        parsed.namingRule === 'date_index' ||
        parsed.namingRule === 'original' ||
        parsed.namingRule === 'title'
          ? parsed.namingRule
          : DEFAULT_SETTINGS.namingRule,
      autoFillClipboard:
        typeof parsed.autoFillClipboard === 'boolean'
          ? parsed.autoFillClipboard
          : DEFAULT_SETTINGS.autoFillClipboard,
      storageType:
        parsed.storageType === 'downloads' ||
        parsed.storageType === 'custom' ||
        parsed.storageType === 'pictures'
          ? parsed.storageType
          : DEFAULT_SETTINGS.storageType,
      customTreeUri:
        typeof parsed.customTreeUri === 'string'
          ? parsed.customTreeUri
          : DEFAULT_SETTINGS.customTreeUri,
      locale:
        typeof parsed.locale === 'string' &&
        (APP_CONFIG.i18n.supportedLocales as readonly string[]).includes(
          parsed.locale,
        )
          ? (parsed.locale as SupportedLocale)
          : DEFAULT_SETTINGS.locale,
      theme:
        typeof parsed.theme === 'string' &&
        (parsed.theme === 'light' ||
          parsed.theme === 'dark' ||
          parsed.theme === 'system')
          ? parsed.theme
          : DEFAULT_SETTINGS.theme,
    };
    return cache;
  } catch {
    cache = DEFAULT_SETTINGS;
    return cache;
  }
}

export async function saveSettings(next: AppSettings): Promise<void> {
  cache = next;
  await setSetting(SETTINGS_KEY, JSON.stringify(next));
}

/** Read the in-memory cache (returns defaults if not yet loaded). */
export function getSettingsSync(): AppSettings {
  return cache ?? DEFAULT_SETTINGS;
}

/** Reset the in-memory cache (tests only). */
export function _resetSettingsCacheForTests(): void {
  cache = null;
}
