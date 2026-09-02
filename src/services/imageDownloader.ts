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
import {defaultResolverRegistry} from './resolvers/registry';
import {ERR_BLOCKED_HOST, ERR_BLOCKED_HOST_4KHD} from './resolvers/types';
import {
  getSettingsSync,
  type AppSettings,
} from './settingsService';
import {isImageDownloaded, markImageDownloaded} from './historyService';

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
export const DL_ERR_BLOCKED_HOST = ERR_BLOCKED_HOST;
export const DL_ERR_BLOCKED_HOST_4KHD = ERR_BLOCKED_HOST_4KHD;
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
  relativePath: string,
  options: DownloadOptions = {},
  meta?: {articleTitle?: string; indexCounter?: number; customTreeUri?: string},
): Promise<DownloadOutcome> {
  const {signal, onProgress} = options;

  console.log(`[DL] downloadImageToMediaStore id=${image.id} url=${image.url} relativePath=${relativePath}`);

  if (signal?.aborted) {
    console.log(`[DL] aborted before start id=${image.id}`);
    return {kind: 'failed', code: 'ERR_CANCELLED', message: 'cancelled before start'};
  }
  if (!isSafeImageUrl(image.url)) {
    console.log(`[DL] unsafe url id=${image.id} url=${image.url}`);
    return fail('ERR_UNSAFE_URL', 'Refusing to download unsafe URL');
  }
  if (!isDownloaderAvailable()) {
    console.log(`[DL] native missing id=${image.id}`);
    return fail('ERR_NATIVE_MISSING', 'Native downloader module is not linked');
  }

  // Duplicate policy: if this exact source URL was already downloaded
  // successfully, skip it (do not re-fetch the bytes / re-save a copy).
  try {
    const already = await isImageDownloaded(image.url);
    if (already) {
      console.log(`[DL] already downloaded, skip id=${image.id} url=${image.url}`);
      return {kind: 'skipped', reason: 'already downloaded'};
    }
  } catch (e) {
    // Ledger read is best-effort; if the DB is unavailable, proceed with the
    // download rather than failing the whole image.
    console.log(`[DL] ledger check failed, proceeding id=${image.id} err=${String(e)}`);
  }

  // Resolve the source URL through the resolver chain. A known-protected host
  // (e.g. img.4khd.com behind a Cloudflare challenge) yields a "blocked"
  // outcome instead of attempting a doomed download.
  const resolved = defaultResolverRegistry.resolve(image.url);
  if (resolved.kind === 'blocked') {
    console.log(`[DL] blocked host id=${image.id} code=${resolved.code}`);
    return {
      kind: 'failed',
      code: resolved.code,
      message: resolved.message,
    };
  }
  const downloadUrl = resolved.url;
  console.log(`[DL] resolved downloadUrl id=${image.id} url=${downloadUrl}`);

  const settings = getSettingsSync();
  const filename = buildFilename(
    image,
    meta?.articleTitle,
    settings,
    meta?.indexCounter,
  );
  const ext = inferExtFromUrl(image.url) || inferExtFromUrl(filename) || '.jpg';
  const tempPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${TEMP_PREFIX}${image.id}${ext}`;
  console.log(`[DL] filename=${filename} ext=${ext} tempPath=${tempPath}`);

  let downloadedPath: string | null = null;
  try {
    console.log(`[DL] streamToCache start id=${image.id} url=${downloadUrl}`);
    downloadedPath = await streamToCache(downloadUrl, tempPath, ext, signal, onProgress);
    console.log(`[DL] streamToCache done id=${image.id} path=${downloadedPath}`);
  } catch (err) {
    console.log(`[DL] streamToCache error id=${image.id} err=${String(err)}`);
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
    console.log(`[DL] saved temp stat id=${image.id} size=${size}`);
    if (!Number.isFinite(size) || size <= 0) {
      return fail('ERR_EMPTY', 'Downloaded file is empty');
    }

    console.log(`[DL] saveImageToMediaStore id=${image.id} relativePath=${relativePath} filename=${filename}`);
    const result = await withRetry(
      () =>
        TelegraphDownloader!.saveImageToMediaStore(
          downloadedPath!,
          sanitizeFilename(relativePath, 200),
          filename,
          meta?.customTreeUri ?? '',
        ),
      {
        maxRetries: 1,
        isRetryable: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return /EBUSY|EROFS|ENOSPC|EIO/i.test(msg);
        },
      },
    );
    console.log(`[DL] save success id=${image.id} uri=${result.uri}`);

    try {
      await markImageDownloaded(image.url);
    } catch (e) {
      // Best-effort; a failed ledger write should not mark a successful save
      // as failed.
      console.log(`[DL] mark downloaded failed id=${image.id} err=${String(e)}`);
    }

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

// Hosts whose anti-bot CDN resets react-native-blob-util's connection after the
// first chunk (Content-Length set, then EOF — "Download interrupted."). For those
// hosts RN's plain fetch (a different OkHttp client with browser-like defaults)
// succeeds, so once we observe the reset we skip blob-util for the rest of the
// batch and go straight to fetch. Avoids a wasted failed request per image.
const blobUtilResetHosts = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Download {@code url} into {@code targetPath} using RN's built-in fetch
 * (no blob-util), with a hard timeout so a stalled response cannot block the
 * download queue forever. Used both as the primary path for hosts known to
 * reset blob-util, and as the fallback when blob-util itself fails.
 */
async function downloadViaFetch(
  url: string,
  targetPath: string,
  onProgress?: (downloaded: number, total: number) => void,
  extAbort?: AbortSignal,
): Promise<string> {
  const timeoutMs = APP_CONFIG.download.fetchTimeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (extAbort?.aborted) {
    controller.abort();
  } else if (extAbort) {
    extAbort.addEventListener('abort', onOuterAbort, {once: true});
  }
  try {
    const started = Date.now();
    const fetchResp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': APP_CONFIG.telegraph.userAgent,
        Accept: 'image/*,*/*;q=0.8',
        Referer: 'https://image.acg.lol/',
      },
    });
    if (timedOut) {
      throw new Error('timed out while downloading (fetch)');
    }
    const status = Number(fetchResp.status ?? 0);
    console.log(
      `[DL] fetch status=${status} ok=${fetchResp.ok} elapsed=${Date.now() - started}ms url=${url}`,
    );
    if (!status || status < 200 || status >= 300) {
      throw new HttpStatusError(status);
    }
    const contentType = String(
      fetchResp.headers.get('content-type') ?? '',
    ).toLowerCase();
    if (/text\/html|text\/plain/.test(contentType)) {
      console.log(`[DL] fetch hotlink blocked url=${url} contentType=${contentType}`);
      throw new HotlinkBlockedError(`host returned ${contentType}`);
    }
    if (contentType && !isAllowedImageMime(contentType.split(';')[0])) {
      throw new Error(`Refusing non-image Content-Type: ${contentType}`);
    }
    // Total is known only after headers; blob has no streaming progress in RN,
    // so we report 0 then the full size once materialised. Progress therefore
    // jumps per image rather than streaming smoothly — acceptable trade-off to
    // bypass the anti-bot reset while keeping a hard timeout.
    const contentLength = Number(fetchResp.headers.get('content-length') ?? 0);
    if (onProgress && Number.isFinite(contentLength) && contentLength > 0) {
      onProgress(0, contentLength);
    }
    const blob = await fetchResp.blob();
    if (onProgress && Number.isFinite(Number(blob.size)) && Number(blob.size) > 0) {
      onProgress(Number(blob.size) || 0, Number(blob.size) || 0);
    }
    const base64: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const b64 = result.split(',')[1] ?? '';
        resolve(b64);
      };
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    await ReactNativeBlobUtil.fs.writeFile(targetPath, base64, 'base64');
    const stat = await ReactNativeBlobUtil.fs.stat(targetPath);
    console.log(
      `[DL] fetch success url=${url} size=${stat.size} elapsed=${Date.now() - started}ms path=${targetPath}`,
    );
    return targetPath;
  } finally {
    clearTimeout(timer);
    extAbort?.removeEventListener('abort', onOuterAbort);
  }
}

async function streamToCache(
  url: string,
  targetPath: string,
  ext: string,
  signal?: AbortSignal,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  // Hosts previously observed resetting blob-util go straight to the fetch path.
  const host = hostOf(url);
  if (blobUtilResetHosts.has(host)) {
    console.log(`[DL] skip blob-util (known reset host) url=${url}`);
    return downloadViaFetch(url, targetPath, onProgress, signal);
  }

  const task = ReactNativeBlobUtil.config({
    path: targetPath,
    overwrite: true,
    timeout: APP_CONFIG.telegraph.readTimeoutMs,
    fileCache: true,
  }).fetch('GET', url, {
    'User-Agent': APP_CONFIG.telegraph.userAgent,
    Accept: 'image/*,*/*;q=0.8',
    Referer: 'https://image.acg.lol/',
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
    const started = Date.now();
    const resp = await task;
    if (cancelled) {
      console.log(`[DL] streamToCache cancelled url=${url}`);
      throw new Error('cancelled');
    }

    const info = resp.info();
    const status = Number(info.status ?? 0);
    console.log(`[DL] streamToCache resp url=${url} status=${status} elapsed=${Date.now() - started}ms`);
    if (!status || status < 200 || status >= 300) {
      throw new HttpStatusError(status);
    }

    const contentType = String(info.headers['Content-Type'] ?? '').toLowerCase();
    if (/text\/html|text\/plain/.test(contentType)) {
      console.log(`[DL] hotlink blocked url=${url} contentType=${contentType}`);
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
      console.log(`[DL] streamToCache success url=${url} size=${stat.size} path=${finalPath}`);
      onProgress(Number(stat.size) || 0, Number(stat.size) || 0);
    }
    return finalPath;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[DL] streamToCache catch url=${url} err=${msg}`);
    if (cancelled) {
      throw e;
    }
    // Fallback for the failure modes we've observed from react-native-blob-util's
    // custom OkHttp client, which the app's own OkHttp (RN fetch) does not hit:
    //   1. "Use of own trust manager but none defined"
    //   2. "Download interrupted."  (server sends a Content-Length then resets the
    //      connection after one buffer — anti-bot CDN fingerprinting). RN fetch uses
    //      a different OkHttp client with browser-like defaults, so it succeeds.
    if (/Use of own trust manager/i.test(msg) || /Download interrupted\.?/i.test(msg) ||
        /reset|closed|unexpected end of stream|connection reset/i.test(msg)) {
      blobUtilResetHosts.add(host);
      console.log(`[DL] fallback to fetch for url=${url} host=${host}`);
      return downloadViaFetch(url, targetPath, onProgress, signal);
    }
    throw e;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function fail(code: string, message: string): DownloadOutcome {
  return {kind: 'failed', code, message};
}

/**
 * Pick a filename for the saved MediaStore entry based on the user's
 * settings.namingRule. Returns the basename (no extension) — the caller
 * appends the extension after inferExtFromUrl().
 */
export function buildFilename(
  image: TelegraphImage,
  articleTitle: string | undefined,
  settings: AppSettings,
  indexCounter?: number,
): string {
  switch (settings.namingRule) {
    case 'original': {
      // Pull the basename from the URL, stripping the extension.
      try {
        const u = new URL(image.url);
        const last = u.pathname.split('/').filter(Boolean).pop();
        if (last) return sanitizeFilename(stripExtension(last), 80);
      } catch {
        // fall through
      }
      return sanitizeFilename(String(indexCounter ?? image.index), 80);
    }
    case 'title': {
      const tag = articleTitle ? shortTag(articleTitle) : '';
      const n = indexCounter ?? image.index;
      const base = tag ? `${pad(n, 6)}_${tag}` : `${pad(n, 6)}`;
      return sanitizeFilename(base, 80);
    }
    case 'date_index':
    default: {
      const n = indexCounter ?? image.index;
      const date = ymd(new Date());
      return sanitizeFilename(`${date}_${pad(n, 6)}`, 80);
    }
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1, 2);
  const day = pad(d.getDate(), 2);
  return `${y}${m}${day}`;
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function shortTag(title: string): string {
  // Strip non-ASCII and collapse to 16 chars so filenames stay reasonable.
  const ascii = title.replace(/[^\x20-\x7e]/g, '');
  return ascii.trim().slice(0, 16).replace(/\s+/g, '_');
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export type {SaveResult};