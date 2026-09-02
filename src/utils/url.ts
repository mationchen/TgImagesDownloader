const TELEGRAPH_HOST = 'telegra.ph';
const TELEGRAPH_PROTOCOL_ALLOWED = ['https:', 'http:'] as const;
const URL_REGEX =
  /https?:\/\/(?:www\.)?telegra\.ph\/[^\s<>"'`]+/gi;

/**
 * A generic http(s) URL anywhere on the web (used for non-Telegraph pages).
 * Kept intentionally broad; SSRF safety is enforced by isSafeFetchUrl.
 */
const WEB_URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

export function extractWebUrls(input: string): string[] {
  if (!input) return [];
  const matches = input.match(WEB_URL_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const cleaned = stripTrailingPunctuation(raw);
    const normalized = normalizeWebUrl(cleaned);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function extractTelegraphUrls(input: string): string[] {
  if (!input) return [];
  const matches = input.match(URL_REGEX);
  if (!matches) return [];
  // Dedup, preserve first-seen order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const cleaned = stripTrailingPunctuation(raw);
    const normalized = normalizeTelegraphUrl(cleaned);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function isValidTelegraphUrl(input: string): boolean {
  return validateTelegraphUrl(input) === null;
}

export type UrlValidationError =
  | 'EMPTY'
  | 'INVALID_PROTOCOL'
  | 'INVALID_HOST'
  | 'INVALID_FORMAT';

export function validateTelegraphUrl(input: string): UrlValidationError | null {
  if (!input || !input.trim()) return 'EMPTY';

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return 'INVALID_FORMAT';
  }

  if (!TELEGRAPH_PROTOCOL_ALLOWED.includes(url.protocol as 'http:' | 'https:')) {
    return 'INVALID_PROTOCOL';
  }

  if (url.hostname.toLowerCase() !== TELEGRAPH_HOST) {
    return 'INVALID_HOST';
  }

  // Must have a path. Bare "https://telegra.ph" is not a valid article URL.
  if (!url.pathname || url.pathname === '/' || url.pathname.length < 2) {
    return 'INVALID_FORMAT';
  }

  return null;
}

/**
 * Normalize a Telegraph URL: trim trailing punctuation that comes from
 * surrounding prose ("https://telegra.ph/x.", "...x)", "...x,"), lower-case
 * the host, drop hash, drop query (Telegraph pages have none), force https.
 */
export function normalizeTelegraphUrl(input: string): string | null {
  if (!input) return null;
  const cleaned = stripTrailingPunctuation(input.trim());
  const valid = validateTelegraphUrl(cleaned);
  if (valid !== null) return null;
  const url = new URL(cleaned);
  // URL properties are read-only in lib.dom; rebuild to mutate.
  const path = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  return `https://${TELEGRAPH_HOST}${path}`;
}

function stripTrailingPunctuation(raw: string): string {
  // Remove characters that commonly trail URLs in natural prose.
  // Note: we keep "/" and "-" since they're valid URL chars.
  let s = raw;
  while (s.length > 0) {
    const last = s.charAt(s.length - 1);
    if ('.,;:!?)]\'"'.includes(last)) {
      s = s.slice(0, -1);
    } else {
      break;
    }
  }
  return s;
}

export type WebUrlValidationError =
  | 'EMPTY'
  | 'INVALID_PROTOCOL'
  | 'SSRF_BLOCKED'
  | 'INVALID_FORMAT';

/**
 * Validate an arbitrary http(s) web URL for parsing (spec §25 SSRF defense).
 * Unlike the Telegraph-only validator, any host is allowed — but we reject
 * obvious internal / private / loopback addresses so the app can't be used
 * as an SSRF proxy.
 */
export function validateWebUrl(input: string): WebUrlValidationError | null {
  if (!input || !input.trim()) return 'EMPTY';
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return 'INVALID_FORMAT';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'INVALID_PROTOCOL';
  }
  if (!isSafeFetchHost(url.hostname)) {
    return 'SSRF_BLOCKED';
  }
  if (!url.pathname || url.pathname === '/' || url.pathname.length < 2) {
    // Bare domain is allowed for web pages (unlike Telegraph).
    return null;
  }
  return null;
}

/** Normalize an arbitrary web URL: trim punctuation, drop hash. */
export function normalizeWebUrl(input: string): string | null {
  if (!input) return null;
  const cleaned = stripTrailingPunctuation(input.trim());
  const valid = validateWebUrl(cleaned);
  if (valid !== null) return null;
  try {
    const url = new URL(cleaned);
    // Rebuild without the fragment (URL.hash is read-only in lib.dom).
    const hashIndex = url.toString().indexOf('#');
    return hashIndex >= 0 ? url.toString().slice(0, hashIndex) : url.toString();
  } catch {
    return null;
  }
}

/**
 * Whether a URL is safe for the app to fetch as a page (SSRF guard).
 * Rejects non-http(s), localhost, loopback, link-local, private IPv4, and
 * clearly-internal hostnames. Applies to the *page* URL, not just images.
 */
export function isSafeFetchUrl(input: string): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return isSafeFetchHost(url.hostname);
  } catch {
    return false;
  }
}

function isSafeFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateOrLoopbackIp(host)
  ) {
    return false;
  }
  return true;
}

/**
 * Sanity-check an arbitrary image URL pulled from Telegraph HTML.
 * Spec §25 (SSRF): only allow http(s); reject anything else.
 * Note: we can't fully prevent DNS rebinding in JS, but we at least enforce
 * the protocol and reject obvious local / file / data schemes.
 */
export function isSafeImageUrl(input: string): boolean {
  if (!input) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  // Reject obvious SSRF targets (defense in depth; in RN we can't actually
  // resolve the host ourselves, but this catches typos in HTML data).
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateOrLoopbackIp(host)
  ) {
    return false;
  }
  return true;
}

/**
 * Detect RFC 1918 / loopback / link-local IPv4 literals so we don't accept
 * image URLs pointing at internal network addresses. Hostnames are left alone
 * (we can't resolve them in RN, but the OS will when it actually fetches).
 */
function isPrivateOrLoopbackIp(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(p => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : -1;
  });
  if (nums.some(n => n < 0)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 10) return true;             // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 169 && b === 254) return true;           // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
