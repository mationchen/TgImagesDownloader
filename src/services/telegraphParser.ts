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

import { APP_CONFIG } from '../constants/config';
import {
  isSafeImageUrl,
  isSafeFetchUrl,
  normalizeTelegraphUrl,
  normalizeWebUrl,
  validateTelegraphUrl,
  validateWebUrl,
} from '../utils/url';
import { inferExtFromUrl } from '../utils/mime';
import { isRetryableHttpStatus, withRetry } from '../utils/retry';
import type {
  ParseErrorCode,
  ParseResult,
  TelegraphArticle,
  TelegraphImage,
} from '../types/telegraph';
import { defaultAdapterRegistry } from './adapters/registry';

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

export type ParseStage =
  /** Resolving/normalising the URL through the adapter registry. */
  | 'resolving'
  /** Fetching the page HTML from the source host. */
  | 'fetching'
  /** Parsing the fetched HTML into a structured article. */
  | 'parsing';

export interface ParseArticleOptions {
  /**
   * Fires when the parser enters a major stage. Used by the Home screen to
   * render real-time feedback (stage label + cancel button) so the user
   * knows what's happening while a fetch may take a long time.
   */
  onStage?: (stage: ParseStage) => void;
  /**
   * Optional AbortSignal: when fired, the fetch will reject with an
   * AbortError so the caller can recover quickly. Supported for both the
   * Telegraph and generic-web parser paths.
   */
  signal?: AbortSignal;
}

/** User-facing label for a parser stage, keyed by i18n namespace `parseStage.*`. */
export const PARSE_STAGE_I18N: Record<ParseStage, string> = {
  resolving: 'parseStage.resolving',
  fetching: 'parseStage.fetching',
  parsing: 'parseStage.parsing',
};

export async function parseTelegraphArticle(
  rawUrl: string,
  opts: ParseArticleOptions = {},
): Promise<ParseResult> {
  opts.onStage?.('resolving');
  const normalized = normalizeTelegraphUrl(rawUrl ?? '');
  if (!normalized) {
    return fail(
      'INVALID_URL',
      '请输入有效的 Telegraph 链接',
      validateTelegraphUrl(rawUrl ?? '') ?? undefined,
    );
  }

  opts.onStage?.('fetching');
  let html: string;
  try {
    html = await fetchHtml(normalized, opts.signal);
  } catch (err) {
    return mapFetchError(err);
  }

  opts.onStage?.('parsing');
  let title: string;
  let images: TelegraphImage[];
  try {
    title = extractTitle(html) || 'untitled';
    images = extractImages(html, normalized);
  } catch (err) {
    return fail(
      'PARSE_ERROR',
      '页面解析失败',
      String((err as Error)?.message ?? err),
    );
  }

  if (images.length === 0) {
    return fail('NO_IMAGES', '这个页面没有找到可下载的图片');
  }

  const article: TelegraphArticle = {
    url: normalized,
    title,
    images,
    parsedAt: Date.now(),
    source: 'telegraph',
  };
  return { ok: true, article };
}

/**
 * Parse a generic web page (non-Telegraph), following its pagination so the
 * user can download a whole multi-page gallery (spec: page-links / /N/ form,
 * e.g. everia.club/.../2/). Images are merged across pages and deduped.
 *
 * SSRF defense (spec §25): the URL is validated with validateWebUrl /
 * isSafeFetchUrl, rejecting private / loopback / internal hosts.
 */
export async function parseWebArticle(
  rawUrl: string,
  opts: { maxPages?: number } & ParseArticleOptions = {},
): Promise<ParseResult> {
  const { maxPages: rawMax, onStage, signal } = opts;
  const maxPages = Math.min(50, Math.max(1, rawMax ?? 20));
  onStage?.('resolving');
  const normalized = normalizeWebUrl(rawUrl ?? '');
  if (!normalized || !isSafeFetchUrl(normalized)) {
    return fail(
      'INVALID_URL',
      '请输入有效的网页链接',
      validateWebUrl(rawUrl ?? '') ?? undefined,
    );
  }

  const seen = new Set<string>();
  let title = '';
  const firstArticleUrl = normalized;
  const fetchedUrls: string[] = [];
  let pageHtmls: { url: string; html: string }[] = [];

  // Fetch the first page; if it carries pagination links we follow them
  onStage?.('fetching');
  let firstHtml: string;
  try {
    firstHtml = await fetchHtml(normalized, signal);
  } catch (err) {
    return mapFetchError(err);
  }
  fetchedUrls.push(normalized);
  pageHtmls.push({ url: normalized, html: firstHtml });
  title = extractTitle(firstHtml) || 'untitled';

  // Resolve site-specific adapter based on the first page's HTML.
  const adapter = defaultAdapterRegistry.resolve(normalized, firstHtml);
  const adapterPagination = adapter.paginationUrls(firstHtml, normalized);
  const genericPagination = collectPaginationUrls(firstHtml, normalized);
  const mergedPagination =
    adapterPagination.length > 0 ? adapterPagination : genericPagination;
  const paginationUrls = mergedPagination.slice(0, maxPages - 1);
  if (paginationUrls.length === 0) {
    // No pagination detected — single page.
    const images = extractWithAdapter(firstHtml, normalized, seen, adapter, {
      skipRelatedCards: true,
    });
    if (images.length === 0) {
      return fail('NO_IMAGES', '这个页面没有找到可下载的图片');
    }
    return {
      ok: true,
      article: {
        url: normalized,
        title,
        images,
        parsedAt: Date.now(),
        source: 'web',
        pageCount: 1,
      },
    };
  }

  // Walk discovered pagination URLs in page-number order, with fallback to
  // sequential /N/ construction for gaps (e.g., 1,3 found but 2 missing).
  // This keeps us robust when a site omits some pagination anchors.
  const urlsToFetch = paginationUrls.filter(u => !fetchedUrls.includes(u));
  // Fill gaps up to maxPages by constructing /N/ URLs for missing indices
  // (WordPress often only renders a window of page numbers).
  const existingNumbers = new Set(urlsToFetch.map(getPageNumber).concat([1]));
  for (let n = 2; n <= maxPages && urlsToFetch.length < maxPages - 1; n += 1) {
    if (existingNumbers.has(n)) continue;
    const constructed = paginationUrl(normalized, n);
    if (
      !isSafeFetchUrl(constructed) ||
      fetchedUrls.includes(constructed) ||
      urlsToFetch.includes(constructed)
    )
      continue;
    // Only add constructed URL if the page likely exists (heuristic: there was
    // at least pagination). We will 404-skip at fetch time if it doesn't.
    // To avoid over-fetching, only fill when we have fewer than expected pages
    // and the constructed URL looks like a pagination candidate.
    if (
      isPaginationCandidate(constructed, normalized) ||
      paginationUrls.length >= 1
    ) {
      // Avoid blindly adding too many; add one at a time until maxPages
      // In practice this covers the common gap case where page 2 link is a
      // rel=next but page 3+ are numeric.
      // We conservatively add only if the gap is within the discovered range.
      const maxDiscovered = Math.max(...Array.from(existingNumbers));
      if (n <= maxDiscovered + 2) {
        urlsToFetch.push(constructed);
        existingNumbers.add(n);
      }
    }
  }
  urlsToFetch.sort((a, b) => getPageNumber(a) - getPageNumber(b));

  for (const pageUrl of urlsToFetch) {
    if (fetchedUrls.includes(pageUrl)) continue;
    if (fetchedUrls.length >= maxPages) break;
    let html: string;
    try {
      html = await fetchHtml(pageUrl, signal);
    } catch {
      // 404 or network on a later page just stops the walk
      break;
    }
    fetchedUrls.push(pageUrl);
    pageHtmls.push({ url: pageUrl, html });
    // Update title if empty (should already be set)
    if (!title) title = extractTitle(html) || 'untitled';
  }

  // Merge images across all fetched pages
  onStage?.('parsing');
  for (const { html, url } of pageHtmls) {
    const imgs = extractWithAdapter(html, url, seen, adapter, {
      skipRelatedCards: true,
    });
    if (pageHtmls[0]!.url === url && imgs.length === 0) {
      return fail('NO_IMAGES', '这个页面没有找到可下载的图片');
    }
  }
  // If later pages yielded no *new* URLs, seen already reflects it; just
  // ensure we had at least something
  const images = Array.from(seen).map((url, index) =>
    buildImage(url, index + 1),
  );
  if (images.length === 0) {
    return fail('NO_IMAGES', '这个页面没有找到可下载的图片');
  }

  return {
    ok: true,
    article: {
      url: firstArticleUrl,
      title,
      images,
      parsedAt: Date.now(),
      source: 'web',
      pageCount: fetchedUrls.length,
    },
  };
}

/** Build the URL for the Nth page of a web article (e.g. base + "/2/"). */
function paginationUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  let path = url.pathname;
  // Strip a trailing "/2/" or "/page/2/" style pagination segment if present.
  path = path.replace(/\/page\/\d+\/?$/i, '/').replace(/\/\d+\/?$/, '');
  if (!path.endsWith('/')) path += '/';
  // URL.pathname is read-only in lib.dom; rebuild the string.
  const suffix = url.search ? `${url.search}` : '';
  return `${url.origin}${path}${page}/${suffix}`;
}

function getBasePrefixPath(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    let p = u.pathname;
    p = p.replace(/\/page\/\d+\/?$/i, '/').replace(/\/\d+\/?$/, '/');
    if (!p.endsWith('/')) p += '/';
    return p;
  } catch {
    return '/';
  }
}

function getPageNumber(urlStr: string): number {
  try {
    const u = new URL(urlStr);
    // path segment .../2/  or .../page/2/
    const m1 = u.pathname.match(/\/page\/(\d+)\/?$/i);
    if (m1) return parseInt(m1[1]!, 10);
    const m2 = u.pathname.match(/\/(\d+)\/?$/);
    if (m2) return parseInt(m2[1]!, 10);
    const qp =
      u.searchParams.get('page') ||
      u.searchParams.get('paged') ||
      u.searchParams.get('p');
    if (qp && /^\d+$/.test(qp)) return parseInt(qp, 10);
    return Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isPaginationCandidate(
  candidateHref: string,
  baseUrl: string,
): boolean {
  try {
    const cand = new URL(candidateHref, baseUrl);
    const base = new URL(baseUrl);
    if (cand.origin !== base.origin) return false;
    if (cand.href === base.href) return false;
    const basePrefix = getBasePrefixPath(baseUrl);
    // Path-based pagination: candidate shares prefix and suffix looks like pagination
    if (
      cand.pathname.startsWith(basePrefix) &&
      cand.pathname !== base.pathname
    ) {
      const suffix = cand.pathname.slice(basePrefix.length);
      if (/^\d+\/?$/.test(suffix) || /^page\/\d+\/?$/i.test(suffix))
        return true;
    }
    // Query-based: same pathname (allow trailing slash variance), query has page param
    const candPathNorm = cand.pathname.endsWith('/')
      ? cand.pathname
      : `${cand.pathname}/`;
    const basePathNorm = base.pathname.endsWith('/')
      ? base.pathname
      : `${base.pathname}/`;
    const basePrefNorm = basePrefix.endsWith('/')
      ? basePrefix
      : `${basePrefix}/`;
    if (candPathNorm === basePathNorm || candPathNorm === basePrefNorm) {
      const qp =
        cand.searchParams.get('page') ||
        cand.searchParams.get('paged') ||
        cand.searchParams.get('p');
      if (qp && /^\d+$/.test(qp) && parseInt(qp, 10) > 1) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function collectPaginationUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  // <link rel="next" href="...">
  const linkRe = /<link\b[^>]*rel\s*=\s*["']next["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0] ?? '';
    const href = pickAttr(tag, 'href');
    if (href) {
      try {
        const abs = new URL(href, baseUrl).toString();
        if (isSafeFetchUrl(abs)) out.add(abs);
      } catch {
        // ignore
      }
    }
  }
  // Alternative order href before rel
  const linkAltRe =
    /<link\b[^>]*href\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*rel\s*=\s*["']next["'][^>]*>/gi;
  while ((m = linkAltRe.exec(html)) !== null) {
    const tag = m[0] ?? '';
    const href = pickAttr(tag, 'href');
    if (href) {
      try {
        const abs = new URL(href, baseUrl).toString();
        if (isSafeFetchUrl(abs)) out.add(abs);
      } catch {
        // ignore
      }
    }
  }
  // <a href="..."> candidates
  const anchorRe =
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    // eslint-disable-next-line no-script-url
    if (!href || href.startsWith('#') || href.startsWith('javascript:'))
      continue;
    if (!isPaginationCandidate(href, baseUrl)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (!isSafeFetchUrl(abs)) continue;
      out.add(abs);
    } catch {
      // ignore
    }
  }
  const arr = Array.from(out);
  arr.sort((a, b) => getPageNumber(a) - getPageNumber(b));
  return arr;
}

/**
 * Heuristic: does the page HTML contain pagination markers we should follow?
 * Now backed by collectPaginationUrls for broader site support.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function hasMorePages(html: string, baseUrl: string): boolean {
  return collectPaginationUrls(html, baseUrl).length > 0;
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    APP_CONFIG.telegraph.readTimeoutMs,
  );
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

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
      return fail('HTTP_FORBIDDEN', 'Telegraph 页面访问被拒绝', `HTTP 403`);
    }
    if (err.status >= 500) {
      return fail(
        'HTTP_SERVER_ERROR',
        'Telegraph 服务器错误，请稍后重试',
        `HTTP ${err.status}`,
      );
    }
    return fail(
      'NETWORK_ERROR',
      `Telegraph 页面请求失败`,
      `HTTP ${err.status}`,
    );
  }
  if (err instanceof ResponseTooLargeError) {
    return fail('RESPONSE_TOO_LARGE', '页面过大，暂不支持', err.message);
  }
  if ((err as Error)?.name === 'AbortError') {
    return fail('TIMEOUT', '网络连接超时，请检查网络后重试');
  }
  return fail(
    'NETWORK_ERROR',
    '网络连接失败，请检查网络后重试',
    String((err as Error)?.message ?? err),
  );
}

function fail(
  code: ParseErrorCode,
  message: string,
  detail?: string,
): ParseResult {
  return { ok: false, error: { code, message, detail } };
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

/** Extended lazy-load attribute dictionary (covered incrementally per site). */
const LAZY_SRC_ATTRS = [
  'data-src',
  'data-original',
  'data-orig-src',
  'data-orig-file',
  'data-lazy-src',
  'data-lazy-srcset',
  'data-hi-res-src',
  'data-full-url',
  'data-zoom-src',
  'data-large-file',
  'zoomfile',
  'data-srcset',
] as const;

/** Hosts/patterns that are never content images (tracking pixel, avatar, etc.). */
const DECORATIVE_HOST_RE =
  /(?:gravatar\.com|googletagmanager|google-analytics|facebook\.com\/tr|doubleclick|adsystem)/i;

function isDecorativeUrl(url: string, attrs: string): boolean {
  if (DECORATIVE_HOST_RE.test(url)) return true;
  if (/^data:image\/svg\+xml/i.test(url)) return true;
  if (url.endsWith('.svg') || url.endsWith('.ico')) return true;
  const w = parseIntOrUndefined(pickAttr(attrs, 'width'));
  const h = parseIntOrUndefined(pickAttr(attrs, 'height'));
  if (w !== undefined && h !== undefined && w < 120 && h < 120) return true;
  if (
    /avatar|icon|logo|spinner|loading/i.test(attrs) &&
    (w === undefined || w < 200)
  ) {
    // Heuristic: small icon-like images outside article body often carry these tokens
    if (/class=["'][^"']*(avatar|icon|logo)[^"']*["']/i.test(attrs))
      return true;
  }
  return false;
}

function extractImages(
  html: string,
  baseUrl: string,
  externalSeen?: Set<string>,
  opts: { skipRelatedCards?: boolean } = {},
): TelegraphImage[] {
  const seen = externalSeen ?? new Set<string>();
  const images: TelegraphImage[] = [];
  let index = 0;

  const pushUrl = (raw: string | undefined, attrs: string): void => {
    if (!raw) return;
    if (opts.skipRelatedCards && /fifu-featured|post-id=["']?\d+/.test(attrs))
      return;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).toString();
    } catch {
      return;
    }
    if (!isSafeImageUrl(absolute)) return;
    if (isDecorativeUrl(absolute, attrs)) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    index += 1;
    images.push(buildImage(absolute, index, attrs));
  };

  // 1) <img ...>
  const imgTagRe = /<img\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    if (opts.skipRelatedCards && /fifu-featured|post-id=["']?\d+/.test(attrs))
      continue;
    const src =
      pickAttr(attrs, 'src') ||
      pickLazySrc(attrs) ||
      largestSrcsetUrl(pickAttr(attrs, 'srcset')) ||
      largestSrcsetUrl(pickAttr(attrs, 'data-srcset')) ||
      largestSrcsetUrl(pickAttr(attrs, 'data-lazy-srcset'));
    pushUrl(src, attrs);
  }

  // 2) <picture> <source srcset>
  const sourceRe = /<source\b([^>]*)\/?>/gi;
  while ((m = sourceRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const srcset = pickAttr(attrs, 'srcset') || pickAttr(attrs, 'data-srcset');
    const url = largestSrcsetUrl(srcset) || pickAttr(attrs, 'src');
    pushUrl(url, attrs);
  }

  // 3) <a href="*.jpg|png|webp"> — some galleries wrap the full image in an anchor
  const anchorRe =
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/\.(?:jpe?g|png|webp|gif|bmp|avif)(\?.*)?$/i.test(href)) continue;
    // Avoid navigation links that happen to end with an image-like path
    if (/class=["'][^"']*(avatar|logo|icon)[^"']*["']/i.test(m[0] ?? ''))
      continue;
    pushUrl(href, m[0] ?? '');
  }

  // 4) CSS background-image: url(...)
  const bgRe = /background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRe.exec(html)) !== null) {
    const url = (m[1] ?? '').trim();
    if (!url || url.startsWith('data:')) continue;
    pushUrl(url, m[0] ?? '');
  }

  // 5) <meta property="og:image" / twitter:image
  const metaOgRe =
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::url)?["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  while ((m = metaOgRe.exec(html)) !== null) {
    const url = (m[1] ?? '').trim();
    pushUrl(url, m[0] ?? '');
  }
  const metaOgAltRe =
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::url)?["'][^>]*>/gi;
  while ((m = metaOgAltRe.exec(html)) !== null) {
    const url = (m[1] ?? '').trim();
    pushUrl(url, m[0] ?? '');
  }

  // 6) application/ld+json  "image": "https://..."  or ["..."]
  const ldRe =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html)) !== null) {
    const jsonText = m[1] ?? '';
    const urls = extractUrlsFromJsonText(jsonText);
    for (const u of urls) pushUrl(u, '');
  }

  // 7) Inline JS gallery arrays: galleryData = ["https://...jpg", ...]
  // Generic fallback: harvest any https image URL appearing inside <script> blocks
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const js = m[1] ?? '';
    if (!/https?:\/\/[^"'\s]+\.(?:jpe?g|png|webp|gif|bmp|avif)/i.test(js))
      continue;
    // Only harvest from scripts that look like gallery data to avoid noise
    if (
      !/(?:gallery|images|photos|slides|data|__NEXT_DATA__|__INITIAL)/i.test(js)
    )
      continue;
    const urls = js.match(
      /https?:\/\/[^"'\s<>]+\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\?[^\s"']*)?/gi,
    );
    if (!urls) continue;
    for (const u of urls) pushUrl(u, '');
  }

  return images;
}

function pickLazySrc(attrs: string): string | undefined {
  for (const name of LAZY_SRC_ATTRS) {
    const v = pickAttr(attrs, name);
    if (v) return v;
  }
  return undefined;
}

function extractUrlsFromJsonText(jsonText: string): string[] {
  const out: string[] = [];
  try {
    const parsed = JSON.parse(jsonText);
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const cur = stack.pop();
      if (
        typeof cur === 'string' &&
        /^https?:\/\//.test(cur) &&
        /\.(?:jpe?g|png|webp|gif|bmp|avif)/i.test(cur)
      ) {
        out.push(cur);
      } else if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
      } else if (cur && typeof cur === 'object') {
        for (const v of Object.values(cur as Record<string, unknown>))
          stack.push(v);
      }
    }
  } catch {
    // Fallback regex when JSON is not strictly valid
    const re =
      /https?:\/\/[^"'\s<>]+\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\?[^\s"']*)?/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(jsonText)) !== null) out.push(mm[0]);
  }
  return out;
}

function extractWithAdapter(
  html: string,
  baseUrl: string,
  seen: Set<string>,
  adapter: {
    extractImages?: (
      html: string,
      baseUrl: string,
      seen: Set<string>,
      opts?: { skipRelatedCards?: boolean },
    ) => TelegraphImage[] | string[];
  },
  opts: { skipRelatedCards?: boolean } = {},
): TelegraphImage[] {
  if (adapter.extractImages) {
    const custom = adapter.extractImages(html, baseUrl, seen, opts);
    // If adapter returned TelegraphImage[], they are already built and seen is populated
    if (custom.length > 0 && typeof custom[0] === 'object') {
      return custom as TelegraphImage[];
    }
    // If adapter returned string[] (URLs), they have been added to seen; fall through to generic to pick up the rest
  }
  return extractImages(html, baseUrl, seen, opts);
}

function buildImage(
  absolute: string,
  index: number,
  attrs?: string,
): TelegraphImage {
  const ext = inferExtFromUrl(absolute);
  const width = parseIntOrUndefined(
    attrs ? pickAttr(attrs, 'width') : undefined,
  );
  const height = parseIntOrUndefined(
    attrs ? pickAttr(attrs, 'height') : undefined,
  );
  return {
    id: `${index}-${hashShort(absolute)}`,
    index,
    url: absolute,
    filename: `${String(index).padStart(3, '0')}${ext}`,
    mimeType: undefined,
    width,
    height,
    selected: true,
  };
}

function pickAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const m = re.exec(attrs);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || undefined;
}

// Kept for backwards-compat; prefer largestSrcsetUrl
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return largestSrcsetUrl(srcset);
}

function largestSrcsetUrl(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  // srcset = "url1 1x, url2 2x" or "url1 320w, url2 640w" — pick the largest descriptor
  const entries = srcset
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  let bestUrl: string | undefined;
  let bestScore = -1;
  for (const entry of entries) {
    const parts = entry.split(/\s+/);
    const url = parts[0];
    if (!url) continue;
    const descriptor = parts[1] ?? '';
    let score = 0;
    if (/^\d+w$/.test(descriptor)) score = parseInt(descriptor, 10);
    else if (/^\d+(?:\.\d+)?x$/.test(descriptor))
      score = parseFloat(descriptor) * 1000;
    else score = bestScore + 0.1; // no descriptor — treat as incremental
    if (score >= bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }
  return bestUrl;
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
  return s.replace(
    /&(?:amp|lt|gt|quot|apos|#39|nbsp);/g,
    m => entities[m] ?? m,
  );
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

/**
 * Route a URL to the right parser:
 *   - telegra.ph            -> Telegraph parser (strict)
 *   - any other http(s)     -> generic web parser (with pagination)
 * Invalid / unsafe URLs -> INVALID_URL error.
 */
export async function parseArticle(
  rawUrl: string,
  opts: ParseArticleOptions = {},
): Promise<ParseResult> {
  const trimmed = (rawUrl ?? '').trim();
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === 'telegra.ph' || host === 'www.telegra.ph') {
      return parseTelegraphArticle(trimmed, opts);
    }
    return parseWebArticle(trimmed, opts);
  } catch {
    return fail('INVALID_URL', '请输入有效的链接');
  }
}
