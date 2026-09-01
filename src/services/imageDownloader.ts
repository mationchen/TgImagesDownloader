import ReactNativeBlobUtil from 'react-native-blob-util';
import {APP_CONFIG} from '../constants/config';
import type {TelegraphImage} from '../types/telegraph';
import {withRetry} from '../utils/retry';
import {isSafeImageUrl} from '../utils/url';
import {inferExtFromUrl, isAllowedImageMime} from '../utils/mime';
import {
  TelegraphDownloader,
  type SaveResult,
  isDownloaderAvailable,
} from './nativeDownloader';
import {sanitizeFilename} from '../utils/filename';

export type DownloadOutcome =
  | {kind: 'success'; result: SaveResult}
  | {kind: 'skipped'; reason: string}
  | {kind: 'failed'; code: string; message: string};

export type DownloadOptions = {
  /** When aborted, the in-flight blob-util fetch is cancelled and any partial
   * temp file is cleaned up. The returned promise resolves with a cancelled
   * outcome. */
  signal?: AbortSignal;
  /** Progress callback fired as bytes stream from the network. */
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
};

const TEMP_PREFIX = 'tg-img-';

class HttpStatusError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Thrown when an image host replies with an HTML verification page instead of
 * the image — the hallmark of hotlink/anti-hotlink protection (e.g. the
 * `img.4khd.com` -> `4khd.php` 302 trap seen on some Telegraph pages).
 */
class HotlinkBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HotlinkBlockedError';
  }
}

/** Error codes exposed through DownloadOutcome. */
export const DL_ERR_HOTLINK_BLOCKED = 'ERR_HOTLINK_BLOCKED';
export const DL_ERR_NETWORK = 'ERR_DOWNLOAD';
export const DL_ERR_UNSAFE = 'ERR_UNSAFE_URL';
export const DL_ERR_EMPTY = 'ERR_EMPTY';
export const DL_ERR_NATIVE = 'ERR_NATIVE';

/** Probe result for a single image URL (used by the viewer / thumbnails). */
export type ImageProbe =
  | {kind: 'ok'}
  | {kind: 'hotlink'; detail?: string}
  | {kind: 'http'; status: number}
  | {kind: 'network'; detail?: string};

/**
 * Lightweight HEAD probe used to tell a hotlink-blocked host apart from a
 * plain network failure. Uses the RN built-in fetch (OkHttp) which follows
 * redirects; we then inspect the final status + Content-Type.
 */
export async function probeImageUrl(url: string): Promise<ImageProbe> {
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': APP_CONFIG.telegraph.userAgent,
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    const status = resp.status;
    if (status >= 200 && status < 300) {
      const contentType = String(resp.headers.get('content-type') ?? '').toLowerCase();
      if (contentType && /text\/html|text\/plain/.test(contentType)) {
        return {kind: 'hotlink', detail: contentType};
      }
      return {kind: 'ok'};
    }
    if (status === 403 || status === 302 || status === 307 || status === 308) {
      return {kind: 'hotlink', detail: `HTTP ${status}`};
    }
    return {kind: 'http', status};
  } catch (err) {
    return {
      kind: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download a single Telegraph image into the user's gallery under
 * Pictures/TelegraphDownloader/<subfolder>/<filename>.
 *
 * Pipeline:
 *   1. Stream the remote image into the app's cache directory via
 *      react-native-blob-util (so we don't load it into JS memory).
 *   2. Validate HTTP status, response size, and content type.
 *   3. Hand the temp file to the native TelegraphDownloader module, which
 *      inserts it into MediaStore with the correct RELATIVE_PATH.
 *   4. Clean up the temp file.
 *
 * Spec coverage: §11 (skip-existing + delete partial), §12 (HTTP 2xx / size /
 * ext / MIME), §13 (MediaStore on Android 10+, legacy below), §25 (SSRF
 * reject), §26 (no JS-side blob), §28 (exponential backoff on 429/5xx).
 */
export async function downloadImageToMediaStore(
  image: TelegraphImage,
  subfolder: string,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const {signal, onProgress} = options;

  if (signal?.aborted) {
    return {kind: 'failed', code: 'ERR_CANCELLED', message: 'cancelled before start'};
  }
  if (!isSafeImageUrl(image.url)) {
    return fail('ERR_UNSAFE_URL', 'Refusing to download unsafe URL');
  }
  if (!isDownloaderAvailable()) {
    return fail('ERR_NATIVE_MISSING', 'Native downloader module is not linked');
  }

  const filename = sanitizeFilename(image.filename || `${image.index}.jpg`, 120);
  const ext = inferExtFromUrl(filename);
  const tempPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${TEMP_PREFIX}${image.id}.${ext}`;

  let downloadedPath: string | null = null;
  try {
    downloadedPath = await streamToCache(image.url, tempPath, ext, signal, onProgress);
  } catch (err) {
    if (signal?.aborted) {
      return {kind: 'failed', code: 'ERR_CANCELLED', message: 'cancelled mid-download'};
    }
    if (err instanceof HotlinkBlockedError) {
      return fail(
        DL_ERR_HOTLINK_BLOCKED,
        'Source image host blocks direct access (anti-hotlink)',
      );
    }
    const status =
      err instanceof HttpStatusError ? err.status : undefined;
    return fail(
      status ? `HTTP_${status}` : DL_ERR_NETWORK,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const stat = await ReactNativeBlobUtil.fs.stat(downloadedPath);
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) {
      return fail('ERR_EMPTY', 'Downloaded file is empty');
    }

    const result = await withRetry(
      () =>
        TelegraphDownloader!.saveImageToMediaStore(
          downloadedPath!,
          sanitizeFilename(subfolder, 80),
          filename,
        ),
      {
        maxRetries: 1,
        isRetryable: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return /EBUSY|EROFS|ENOSPC|EIO/i.test(msg);
        },
      },
    );

    return {kind: 'success', result};
  } catch (err) {
    if (signal?.aborted) {
      return {kind: 'failed', code: 'ERR_CANCELLED', message: 'cancelled before save'};
    }
    const code =
      typeof err === 'object' && err && 'code' in err
        ? String((err as {code?: unknown}).code ?? 'ERR_NATIVE')
        : 'ERR_NATIVE';
    const message =
      err instanceof Error ? err.message : String(err);
    return fail(code, message);
  } finally {
    if (downloadedPath) {
      ReactNativeBlobUtil.fs.unlink(downloadedPath).catch(() => undefined);
    }
  }
}

async function streamToCache(
  url: string,
  targetPath: string,
  ext: string,
  signal?: AbortSignal,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  const task = ReactNativeBlobUtil.config({
    path: targetPath,
    overwrite: true,
    timeout: APP_CONFIG.telegraph.readTimeoutMs,
  }).fetch('GET', url, {
    'User-Agent': APP_CONFIG.telegraph.userAgent,
    Accept: 'image/*,*/*;q=0.8',
  });

  // Subscribe to progress (bytes received so far) before awaiting.
  if (onProgress) {
    task.progress?.((received: string, total: string) => {
      const r = Number(received);
      const t = Number(total);
      if (Number.isFinite(r)) {
        onProgress(Number.isFinite(t) ? r : 0, Number.isFinite(t) ? t : 0);
      }
    });
  }

  // Wire abort -> blob-util cancel.
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    task.cancel?.(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, {once: true});
    }
  }

  try {
    const resp = await task;
    if (cancelled) {
      throw new Error('cancelled');
    }

    const info = resp.info();
    const status = Number(info.status ?? 0);
    if (!status || status < 200 || status >= 300) {
      throw new HttpStatusError(status);
    }

    const contentType = String(info.headers['Content-Type'] ?? '').toLowerCase();
    // A hotlink-protected host returns an HTML verification page instead of the
    // image. Detect this and surface a dedicated error code so the UI can say
    // "source host blocks direct access" rather than a generic failure.
    if (/text\/html|text\/plain/.test(contentType)) {
      throw new HotlinkBlockedError(`host returned ${contentType}`);
    }
    if (contentType && !isAllowedImageMime(contentType.split(';')[0])) {
      throw new Error(`Refusing non-image Content-Type: ${contentType}`);
    }

    const finalPath = resp.path();
    if (!finalPath) {
      throw new Error('Download completed but no local path was returned');
    }
    if (onProgress) {
      const stat = await ReactNativeBlobUtil.fs.stat(finalPath);
      onProgress(Number(stat.size) || 0, Number(stat.size) || 0);
    }
    return finalPath;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function fail(code: string, message: string): DownloadOutcome {
  return {kind: 'failed', code, message};
}

export type {SaveResult};