/**
 * Helpers for interpreting a stored history `saveDir` (a MediaStore
 * RELATIVE_PATH like `Pictures/TelegraphDownloader/<title>`).
 */

const APP_FOLDER = 'TelegraphDownloader';
const DEFAULT_ROOT = `Pictures/${APP_FOLDER}`;

/**
 * Derive the app's root MediaStore folder from a stored saveDir
 * (e.g. "Pictures/TelegraphDownloader/<title>" -> "Pictures/TelegraphDownloader").
 * Falls back to the Pictures root when the value is unexpected/empty.
 */
export function appRootFromSaveDir(saveDir: string): string {
  const match = /^(Pictures|Download)\/TelegraphDownloader/.exec(saveDir);
  return match ? match[0] : DEFAULT_ROOT;
}

/**
 * Whether {@code saveDir} is the app's shared base folder — the default
 * "no subfolder" layout where every article's files coexist.
 *
 * Listing a shared folder returns EVERY record's images, so callers that want
 * a single record's photos must not use it (this caused the "every history
 * detail shows the same batch" bug). An empty/unset saveDir counts as shared.
 */
export function isSharedSaveFolder(
  saveDir: string | null | undefined,
): boolean {
  const dir = (saveDir ?? '').replace(/\/+$/, '');
  if (!dir) return true;
  return dir === appRootFromSaveDir(dir);
}
