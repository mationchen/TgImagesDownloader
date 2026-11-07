import type { HistoryRecord } from '../services/historyService';

/** Hide by URI, never zip imageUrls with imagePaths (failed downloads break alignment).
 * Stored arrays stay untouched so restoring also restores the original order.
 */
export function hideRecycledImages(
  record: HistoryRecord,
  hidden: ReadonlySet<string>,
): HistoryRecord {
  const paths = record.imagePaths.filter(uri => !hidden.has(uri));
  const urls = record.imageUrls.filter(uri => !hidden.has(uri));
  return {
    ...record,
    imagePaths: paths,
    imageUrls: urls,
    savePaths: record.savePaths.length === record.imagePaths.length
      ? record.savePaths.filter((_, i) => !hidden.has(record.imagePaths[i]))
      : record.savePaths,
    coverUri: hidden.has(record.coverUri) ? '' : record.coverUri,
    hasStoredImages: record.imagePaths.length > 0,
    hiddenImageCount: record.imagePaths.length - paths.length + record.imageUrls.length - urls.length,
  };
}
