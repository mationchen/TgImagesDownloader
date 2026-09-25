import { Alert } from 'react-native';
import { t } from '../i18n';
import {
  removeDownloadedImages,
  removeHistory,
  type HistoryRecord,
} from '../services/historyService';
import { TelegraphDownloader } from '../services/nativeDownloader';
import { parseArticle } from '../services/telegraphParser';
import type { TelegraphArticle } from '../types/telegraph';

/**
 * Row actions for a 下载记录 entry: 重新解析 / 删除（可连带删除图片）.
 *
 * Shared by the history list (long-press) and the detail page (icon buttons)
 * so both surfaces offer exactly the same behaviour and wording
 * (AGENTS.md §5).
 */

export interface HistoryRowActionHandlers {
  /** Re-parse succeeded; the caller should open the preview screen. */
  onReparsed: (article: TelegraphArticle) => void;
  /** The row was deleted from the DB; the caller refreshes / navigates away. */
  onDeleted: (record: HistoryRecord) => void;
}

/**
 * Set when a row is deleted from outside the list screen, so the list can
 * refresh when it next regains focus without reloading on every tab switch.
 */
let historyChanged = false;

/** Record that history rows changed on another screen. */
export function markHistoryChanged(): void {
  historyChanged = true;
}

/** True exactly once after such a change; clears the flag. */
export function consumeHistoryChanged(): boolean {
  const changed = historyChanged;
  historyChanged = false;
  return changed;
}

/**
 * Re-parse a record's article.
 *
 * `parseArticle` routes by host (telegra.ph vs. generic web pages) — using the
 * Telegraph-only parser here made every non-Telegraph record fail with
 * "解析失败". Resolves `null` (after showing an error) when parsing fails; the
 * caller owns any progress UI.
 */
export async function reparseRecord(
  record: HistoryRecord,
): Promise<TelegraphArticle | null> {
  const result = await parseArticle(record.url);
  if (result.ok && result.article) return result.article;
  Alert.alert(t('error.parseError'));
  return null;
}

/**
 * Confirm deleting a record, offering to remove its saved images as well.
 *
 * "仅删除记录" removes the history row only — the files stay in the gallery.
 * "删除记录和图片" asks a second time before touching the gallery, because
 * that cannot be undone.
 */
export function confirmDeleteRecord(
  record: HistoryRecord,
  handlers: HistoryRowActionHandlers,
): void {
  Alert.alert(t('history.deleteConfirmTitle'), t('history.deleteConfirmMsg'), [
    { text: t('history.cancel'), style: 'cancel' },
    {
      text: t('history.deleteRecordOnly'),
      style: 'destructive',
      onPress: () => {
        performDelete(record, handlers, false).catch(() => undefined);
      },
    },
    {
      text: t('history.deleteWithImages'),
      style: 'destructive',
      onPress: () => confirmDeleteImages(record, handlers),
    },
  ]);
}

/** Second confirmation before deleting the saved image files. */
function confirmDeleteImages(
  record: HistoryRecord,
  handlers: HistoryRowActionHandlers,
): void {
  // Prefer the recorded local paths (what will really be removed) and fall
  // back to the image count so the warning is never misleading.
  const count = (record.imagePaths ?? []).length || record.imageCount;
  Alert.alert(
    t('history.deleteImagesConfirmTitle'),
    t('history.deleteImagesConfirmMsg', { count }),
    [
      { text: t('history.cancel'), style: 'cancel' },
      {
        text: t('history.deleteImagesConfirmOk'),
        style: 'destructive',
        onPress: () => {
          performDelete(record, handlers, true).catch(() => undefined);
        },
      },
    ],
  );
}

/** Delete the row (and optionally its images), then notify the caller. */
async function performDelete(
  record: HistoryRecord,
  handlers: HistoryRowActionHandlers,
  withImages: boolean,
): Promise<void> {
  try {
    if (withImages) {
      const paths = (record.imagePaths ?? []).filter(
        u => u.startsWith('content://') || u.startsWith('file://'),
      );
      if (paths.length > 0 && TelegraphDownloader?.deleteGalleryImages) {
        await TelegraphDownloader.deleteGalleryImages(paths);
      }
      // Drop the ledger rows too: they are what makes a later re-download skip
      // URLs it believes are already saved, so stale entries would make the
      // next run skip every image of a record whose files are gone.
      await removeDownloadedImages(record.imageUrls ?? []);
    }
    await removeHistory(record.id);
  } catch {
    // Best-effort: if the delete failed the row is still there, so don't tell
    // the caller it was removed.
    return;
  }
  markHistoryChanged();
  handlers.onDeleted(record);
}

/**
 * The list's long-press menu. The detail page uses the same actions through
 * its own icon buttons ({@link reparseRecord} / {@link confirmDeleteRecord}).
 */
export function showHistoryRowActions(
  record: HistoryRecord,
  handlers: HistoryRowActionHandlers,
): void {
  Alert.alert(record.title, undefined, [
    {
      text: t('history.reparse'),
      onPress: async () => {
        const article = await reparseRecord(record);
        if (article) handlers.onReparsed(article);
      },
    },
    {
      text: t('history.delete'),
      style: 'destructive',
      onPress: () => confirmDeleteRecord(record, handlers),
    },
    { text: t('history.cancel'), style: 'cancel' },
  ]);
}
