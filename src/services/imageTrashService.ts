import { finishPurgingTrashedImage, listTrashedImages, type TrashedImage } from './historyService';
import { TelegraphDownloader } from './nativeDownloader';
import { withImageTrashLock } from '../utils/imageTrashLock';

/** Snapshot-based: never clears items added after the user confirmed.
 * Failures remain in the bin; unsupported platforms never silently lose metadata.
 */
export async function purgeTrashedImages(items: TrashedImage[]): Promise<{ deleted: number; failed: number }> {
  return withImageTrashLock(async () => {
    const active = new Set((await listTrashedImages()).map(item => item.uri));
    let deleted = 0;
    const unique = [...new Map(items.map(item => [item.uri, item])).values()];
    for (const item of unique) {
      // A stale confirmation must never delete a file that was already restored.
      if (!active.has(item.uri)) continue;
      try {
        const remoteOnly = /^https?:\/\//i.test(item.uri);
        if (!remoteOnly) {
          if (!TelegraphDownloader?.deleteImageForTrash) continue;
          if (!(await TelegraphDownloader.deleteImageForTrash(item.uri))) continue;
        }
        await finishPurgingTrashedImage(item.uri);
        deleted += 1;
      } catch {
        // Keep this row for retry; don't claim the whole bin was cleared.
      }
    }
    return { deleted, failed: unique.length - deleted };
  });
}
