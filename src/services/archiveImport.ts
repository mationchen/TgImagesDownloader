import {
  deriveHistoryStatus,
  getDownloadedImagePaths,
  isImageDownloaded,
  markImageDownloaded,
  upsertHistory,
} from './historyService';
import { TelegraphDownloader } from './nativeDownloader';
import { getSettingsSync, computeBaseRelativePath } from './settingsService';
import {
  extractArchiveEntries,
  inspectArchive,
  isArchiveSupported,
  type ArchiveImageEntry,
} from './archiveService';
import { sanitizeFilename } from '../utils/filename';

/**
 * Import one local archive into the gallery and record it in 下载记录.
 *
 * Identity / de-duplication (the reason this is content- rather than
 * name-based): the native side returns a fingerprint over the archive's
 * central directory, so the same archive re-downloaded under a new name
 * (`xxx.zip` → `xxx (1).zip`) maps to the same history row and the same ledger
 * keys.
 *
 *   history.url            = archive://<fingerprint>
 *   downloaded_images.url   = <fingerprint>#<path inside the archive>
 */

/** Failure reasons surfaced to the user (mapped to i18n in the UI). */
export type ArchiveImportReason =
  | 'ENCRYPTED'
  | 'NO_IMAGES'
  | 'TOO_LARGE'
  | 'TOO_MANY_ENTRIES'
  | 'UNREADABLE'
  | 'UNSUPPORTED';

export interface ArchiveImportResult {
  /** `done` also covers the "everything was already imported" case. */
  status: 'done' | 'partial' | 'failed';
  success: number;
  skipped: number;
  failed: number;
  total: number;
  /** Set when the archive could not be processed at all. */
  reason?: ArchiveImportReason;
}

/** Ledger key for one image inside one archive. */
export function archiveLedgerKey(
  fingerprint: string,
  entryPath: string,
): string {
  return `${fingerprint}#${entryPath}`;
}

/** Synthetic history URL that makes duplicate imports collapse into one row. */
export function archiveHistoryUrl(fingerprint: string): string {
  return `archive://${fingerprint}`;
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * Extract, save and record one archive.
 *
 * Best-effort per image: individual failures are counted and the record is
 * written with whatever succeeded, so a partially-damaged archive still shows
 * its usable images.
 */
export async function importArchive(
  archiveUri: string,
  archiveName: string,
): Promise<ArchiveImportResult> {
  if (!isArchiveSupported() || !TelegraphDownloader?.saveImageToMediaStore) {
    return {
      status: 'failed',
      success: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      reason: 'UNSUPPORTED',
    };
  }

  const inspection = await inspectArchive(archiveUri);
  if (!inspection.ok) {
    return {
      status: 'failed',
      success: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      reason: (inspection.error as ArchiveImportReason) ?? 'UNREADABLE',
    };
  }
  if (inspection.encrypted) {
    return {
      status: 'failed',
      success: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      reason: 'ENCRYPTED',
    };
  }

  const fingerprint = inspection.fingerprint ?? '';
  const images = inspection.images ?? [];
  const total = images.length;
  if (total === 0) {
    return {
      status: 'failed',
      success: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      reason: 'NO_IMAGES',
    };
  }

  // Which entries still need work? Already-imported ones are skipped, which is
  // what makes re-importing the same archive cheap.
  const needed: ArchiveImageEntry[] = [];
  let skipped = 0;
  for (const image of images) {
    const key = archiveLedgerKey(fingerprint, image.path);
    if (await isImageDownloaded(key)) skipped += 1;
    else needed.push(image);
  }

  const settings = getSettingsSync();
  const saveDir = computeBaseRelativePath(settings);
  const historyUrl = archiveHistoryUrl(fingerprint);

  if (needed.length === 0) {
    // Nothing new to do. Refresh the row so the detail grid can still resolve
    // its images from the ledger (same trick as an all-skipped web re-run).
    const ledgerPaths = await getDownloadedImagePaths(
      images.map(image => archiveLedgerKey(fingerprint, image.path)),
    );
    const imagePaths = images
      .map(image => ledgerPaths.get(archiveLedgerKey(fingerprint, image.path)))
      .filter((p): p is string => !!p);
    await upsertHistory({
      url: historyUrl,
      title: archiveName,
      imageCount: total,
      successCount: 0,
      failedCount: 0,
      skippedCount: skipped,
      saveDir,
      status: 'done',
      imageUrls: images.map(image => archiveLedgerKey(fingerprint, image.path)),
      imagePaths,
      savePaths: [],
    });
    return { status: 'done', success: 0, skipped, failed: 0, total };
  }

  const extracted = await extractArchiveEntries(
    archiveUri,
    needed.map(image => image.path),
  );

  const byPath = new Map(needed.map(image => [image.path, image]));
  const token = fingerprint.slice(0, 6) || 'arc';
  const imageUrls: string[] = [];
  const imagePaths: string[] = [];
  const savePaths: string[] = [];
  let success = 0;
  let failed = 0;
  let index = 0;

  for (const item of extracted.items) {
    const entry = byPath.get(item.path);
    if (!entry) continue;
    index += 1;
    const key = archiveLedgerKey(fingerprint, entry.path);
    try {
      const base = sanitizeFilename(entry.name.replace(/\.[^.]+$/, ''), 60);
      // No subfolder: every archive lands in the shared folder, and the
      // fingerprint token keeps names unique across archives.
      const filename = `${base}_${token}_${pad(index)}${extensionOf(
        entry.name,
      )}`;
      const saved = await TelegraphDownloader.saveImageToMediaStore(
        item.tmpPath,
        '',
        filename,
        settings.storageType === 'custom' ? settings.customTreeUri : '',
        settings.storageType,
      );
      imageUrls.push(key);
      imagePaths.push(saved.uri);
      savePaths.push(
        saved.subfolder
          ? `${saved.subfolder}/${saved.filename}`
          : saved.filename,
      );
      await markImageDownloaded(key, saved.uri);
      success += 1;
    } catch {
      failed += 1;
    }
  }

  // Entries the extractor itself reported as failed, plus anything that never
  // came back at all.
  failed += extracted.failed.length;
  const accounted = success + failed;
  if (accounted < needed.length) failed += needed.length - accounted;

  await upsertHistory({
    url: historyUrl,
    title: archiveName,
    imageCount: total,
    successCount: success,
    failedCount: failed,
    skippedCount: skipped,
    saveDir,
    status: deriveHistoryStatus(failed, total),
    imageUrls,
    imagePaths,
    savePaths,
  });

  return {
    status: failed === 0 ? 'done' : success === 0 ? 'failed' : 'partial',
    success,
    skipped,
    failed,
    total,
  };
}
