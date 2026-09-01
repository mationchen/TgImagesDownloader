/**
 * Convert a parsed article title into a safe subdirectory name.
 * Spec §9: limit filename length, strip path-traversal chars and reserved
 * Windows/POSIX chars.
 */
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeFilename(input: string, maxLen = 100): string {
  if (!input) return 'untitled';
  // Strip control chars and reserved filename chars
  const cleaned = input
    .replace(INVALID_CHARS, '_')
    // Collapse spaces, strip leading/trailing dots and whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  // If sanitization left us with nothing useful (only underscores / spaces),
  // fall back to a stable placeholder rather than an empty-looking filename.
  const meaningful = cleaned.replace(/_/g, '').trim();
  if (!meaningful) return 'untitled';
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trim();
}

/**
 * Build a zero-padded filename like "001.jpg" given a 1-based index.
 */
export function buildIndexFilename(
  index: number,
  ext: string,
  padTo = 3,
): string {
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  const n = Math.max(1, Math.floor(index));
  const padded = String(n).padStart(padTo, '0');
  return `${padded}${safeExt}`;
}
