/**
 * Pure scheduler helpers for the Batch URL-download screen. Kept
 * dependency-free so they can be unit-tested without RN.
 */

/**
 * Strip whitespace + dedupe URLs from a `url.txt` payload, preserving
 * insertion order. Trims, drops blank lines, and removes later
 * occurrences of a previously-seen URL.
 *
 * Intentionally case-sensitive: we don't silently rewrite the user's
 * list; sites that serve the same path under mixed case are rare and the
 * user can fix typos themselves.
 */
export function dedupeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
