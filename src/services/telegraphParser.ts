/**
 * Telegraph HTML parser.
 *
 * Strategy:
 *   1. fetch HTML via fetch() with a timeout (AbortController).
 *   2. Validate HTTP status (404/403/5xx -> typed errors).
 *   3. Extract <title>...</title>.
 *   4. Extract every <img src="...">, plus srcset / data-src fallbacks.
 *   5. Resolve relative URLs against the article URL (Telegraph images are
 *      usually absolute, but we still normalize).
 *   6. Dedup, keep DOM order.
 *   7. Sanitize image URLs (SSRF defense per spec §25).
 *
 * This is intentionally a small, self-contained parser — no third-party
 * HTML lib — to avoid pulling in a transitive dep we don't need for the
 * Telegraph article format. If we later need richer parsing, we can swap
 * this for an htmlparser2-based implementation without changing the
 * public interface.
 */

import {APP_CONFIG} from '../constants/config';
import {
  isSafeImageUrl,
  normalizeTelegraphUrl,
  validateTelegraphUrl,
} from '../utils/url';
import {inferExtFromUrl} from '../utils/mime';
import {isRetryableHttpStatus, withRetry} from '../utils/retry';
import type {
  ParseErrorCode,
  ParseResult,
  TelegraphArticle,
  TelegraphImage,
} from '../types/telegraph';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function parseTelegraphArticle(
  rawUrl: string,
): Promise<ParseResult> {
  const normalized = normalizeTelegraphUrl(rawUrl ?? '');
  if (!normalized) {
    return fail(
      'INVALID_URL',
      '请输入有效的 Telegraph 链接',
      validateTelegraphUrl(rawUrl ?? '') ?? undefined,
    );
  }

  let html: string;
  try {
    html = await fetchHtml(normalized);
  } catch (err) {
    return mapFetchError(err);
  }

  let title: string;
  let images: TelegraphImage[];
  try {
    title = extractTitle(html) || 'untitled';
    images = extractImages(html, normalized);
  } catch (err) {
    return fail('PARSE_ERROR', '页面解析失败', String((err as Error)?.message ?? err));
  }

  if (images.length === 0) {
    return fail('NO_IMAGES', '这个页面没有找到可下载的图片');
  }

  const article: TelegraphArticle = {
    url: normalized,
    title,
    images,
    parsedAt: Date.now(),
  };
  return {ok: true, article};
}

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    APP_CONFIG.telegraph.readTimeoutMs,
  );

  try {
    const resp = await withRetry(
      async () => {
        const r = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': APP_CONFIG.telegraph.userAgent,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate',
          },
          signal: ctrl.signal,
        });
        if (!r.ok) {
          throw new HttpError(r.status, `HTTP ${r.status}`);
        }
        // Cap response size to avoid OOM on adversarial pages
        const contentLength = Number(r.headers.get('content-length') ?? '0');
        if (
          contentLength > 0 &&
          contentLength > APP_CONFIG.telegraph.maxResponseBytes
        ) {
          throw new ResponseTooLargeError(
            `content-length ${contentLength} > ${APP_CONFIG.telegraph.maxResponseBytes}`,
          );
        }
        const text = await r.text();
        if (text.length > APP_CONFIG.telegraph.maxResponseBytes) {
          throw new ResponseTooLargeError(
            `body length ${text.length} > ${APP_CONFIG.telegraph.maxResponseBytes}`,
          );
        }
        return text;
      },
      {
        maxRetries: APP_CONFIG.telegraph.maxRetries,
        isRetryable: err =>
          err instanceof HttpError &&
          isRetryableHttpStatus((err as HttpError).status),
      },
    );
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function mapFetchError(err: unknown): ParseResult {
  if (err instanceof HttpError) {
    if (err.status === 404) {
      return fail(
        'HTTP_NOT_FOUND',
        'Telegraph 页面不存在或无法访问',
        `HTTP 404`,
      );
    }
    if (err.status === 403) {
      return fail(
        'HTTP_FORBIDDEN',
        'Telegraph 页面访问被拒绝',
        `HTTP 403`,
      );
    }
    if (err.status >= 500) {
      return fail(
        'HTTP_SERVER_ERROR',
        'Telegraph 服务器错误，请稍后重试',
        `HTTP ${err.status}`,
      );
    }
    return fail('NETWORK_ERROR', `Telegraph 页面请求失败`, `HTTP ${err.status}`);
  }
  if (err instanceof ResponseTooLargeError) {
    return fail(
      'RESPONSE_TOO_LARGE',
      '页面过大，暂不支持',
      err.message,
    );
  }
  if ((err as Error)?.name === 'AbortError') {
    return fail('TIMEOUT', '网络连接超时，请检查网络后重试');
  }
  return fail('NETWORK_ERROR', '网络连接失败，请检查网络后重试', String((err as Error)?.message ?? err));
}

function fail(
  code: ParseErrorCode,
  message: string,
  detail?: string,
): ParseResult {
  return {ok: false, error: {code, message, detail}};
}

/* ------------------------------------------------------------------ */
/* HTML extraction                                                     */
/* ------------------------------------------------------------------ */

function extractTitle(html: string): string {
  // Try <title>...</title>
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch && titleMatch[1]) {
    return decodeHtmlEntities(stripTags(titleMatch[1]).trim());
  }
  // Fallback: <meta property="og:title" content="...">
  const ogMatch =
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i.exec(
      html,
    );
  if (ogMatch && ogMatch[1]) {
    return decodeHtmlEntities(ogMatch[1].trim());
  }
  return '';
}

function extractImages(html: string, baseUrl: string): TelegraphImage[] {
  const seen = new Set<string>();
  const images: TelegraphImage[] = [];
  let index = 0;

  // Match every <img ...> tag (case-insensitive, multiline)
  const imgTagRe = /<img\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const src =
      pickAttr(attrs, 'src') ||
      pickAttr(attrs, 'data-src') ||
      pickAttr(attrs, 'data-original') ||
      pickAttr(attrs, 'data-lazy-src') ||
      pickAttr(attrs, 'data-hi-res-src') ||
      firstSrcsetUrl(pickAttr(attrs, 'srcset'));
    if (!src) continue;

    let absolute: string;
    try {
      absolute = new URL(src, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isSafeImageUrl(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    index += 1;
    const ext = inferExtFromUrl(absolute);
    const width = parseIntOrUndefined(pickAttr(attrs, 'width'));
    const height = parseIntOrUndefined(pickAttr(attrs, 'height'));
    images.push({
      id: `${index}-${hashShort(absolute)}`,
      index,
      url: absolute,
      filename: `${String(index).padStart(3, '0')}${ext}`,
      mimeType: undefined,
      width,
      height,
      selected: true,
    });
  }
  return images;
}

function pickAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || undefined;
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  // srcset = "url1 1x, url2 2x" or "url1 320w, url2 640w"
  const first = srcset.split(',')[0]?.trim();
  if (!first) return undefined;
  const url = first.split(/\s+/)[0];
  return url || undefined;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function decodeHtmlEntities(s: string): string {
  // Minimal decoder for the entities we actually see in Telegraph titles.
  // Avoid pulling in a full library.
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
  };
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, m => entities[m] ?? m);
}

function parseIntOrUndefined(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function hashShort(s: string): string {
  // FNV-1a 32-bit, returns hex. Bitwise is intentional here.
  /* eslint-disable no-bitwise */
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
  /* eslint-enable no-bitwise */
}
