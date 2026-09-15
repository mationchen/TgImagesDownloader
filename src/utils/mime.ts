/**
 * Best-effort MIME / extension inference from a URL.
 * Telegraph pages embed images that may omit Content-Type, so we fall back
 * to the URL path. Anything unknown defaults to ".jpg" (most Telegraph
 * images are JPEG; spec §12 only requires "extension is reasonable").
 */

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/avif': '.avif',
};

const DEFAULT_EXT = '.jpg';
const DEFAULT_MIME = 'image/jpeg';

export function inferExtFromUrl(url: string): string {
  if (!url) return DEFAULT_EXT;
  // Strip query / hash
  const cleanPath = url.split('?')[0].split('#')[0];
  const lastSlash = cleanPath.lastIndexOf('/');
  const lastSegment =
    lastSlash >= 0 ? cleanPath.slice(lastSlash + 1) : cleanPath;
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_EXT; // no extension or hidden file like ".bashrc"
  const ext = lastSegment.slice(dot).toLowerCase();
  if (ext.length > 5) return DEFAULT_EXT; // implausibly long extension
  return MIME_BY_EXT[ext] ? ext : DEFAULT_EXT;
}

export function inferMimeFromUrl(url: string): string {
  const ext = inferExtFromUrl(url);
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME;
}

export function inferExtFromMime(mime: string | undefined | null): string {
  if (!mime) return DEFAULT_EXT;
  const lower = mime.toLowerCase();
  return EXT_BY_MIME[lower] ?? DEFAULT_EXT;
}

export function isAllowedImageMime(mime: string | undefined | null): boolean {
  if (!mime) return true; // unknown -> let downstream validate
  return mime.toLowerCase().startsWith('image/');
}
