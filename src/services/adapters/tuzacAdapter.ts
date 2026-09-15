import type { TelegraphImage } from '../../types/telegraph';
import type { SiteAdapter } from './types';

/**
 * tuzac.com — Chinese image gallery.
 *
 * Site quirks:
 *   - Pages are paginated via the query param `?at=N`. Each page shows up to
 *     5 gallery photos, with photo ordering encoded as a numeric suffix on
 *     the image URL (e.g. `120ZQ323-0.jpg`, `120ZT056-1.jpg`, …) and exposed
 *     via `data-photo-num` on the `<img>` element.
 *   - Content images live inside `<div class="image-loading-box">`. The rest
 *     of the page is decorative noise (logo, icons, related-card thumbnails
 *     in `.file-detail-page` neighbours); the generic `<img>` extractor pulls
 *     too many of those in.
 *
 * This adapter only matches `host === www.tuzac.com` and only returns images
 * from `div.image-loading-box > img`. Pagination is handled by the generic
 * loop (`parseWebArticle`) once `getPageNumber` recognises `?at=N`; see
 * `src/services/telegraphParser.ts`.
 */
export class TuzacAdapter implements SiteAdapter {
  readonly name = 'tuzac';

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      // Accept www.tuzac.com and bare tuzac.com; reject anything else.
      return host === 'www.tuzac.com' || host === 'tuzac.com';
    } catch {
      return false;
    }
  }

  paginationUrls(html: string, baseUrl: string): string[] {
    // The generic pagination collector only recognises `?page=N` / `?paged=N`
    // / `?p=N`, but tuzac pages use `?at=N`. Worse, tuzac's pagination
    // links point at a different pathname (`/file/.../11700/?at=N` from the
    // hash-style base `/file/.../<hash>/`) so the generic collector also
    // rejects them as off-path. We have to drive pagination ourselves by
    // scraping the `<div id="pager">` block.
    const out = new Set<string>();
    const pagerRe =
      /<div\b[^>]*\bid\s*=\s*["']pager["'][^>]*>([\s\S]*?)<\/div>/i;
    const m = pagerRe.exec(html);
    if (!m) return [];
    const block = m[1] ?? '';
    const linkRe = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let lm: RegExpExecArray | null;
    let maxAt = 0;
    // Remember the first pager link so we can use its origin + pathname
    // (NOT baseUrl's) as the template for gap-fill. Tuzac's hash-style
    // base URL (`/file/.../<hash>/`) and its pager links (`/file/.../11700/`)
    // live on different paths, and `/file/.../<hash>/N/` is treated as
    // page 1 by the server. Without this, the gap-fill constructs URLs
    // that waste network on re-renders of page 1.
    let templateOrigin = '';
    let templatePathname = '';
    let templateSearch = '';
    while ((lm = linkRe.exec(block)) !== null) {
      const href = (lm[1] ?? '').trim();
      if (!href) continue;
      // Skip anchor-only and javascript: links (page-curr uses href="#").
      if (href.startsWith('#') || href.startsWith('javascript:')) continue;
      let absUrl: URL;
      try {
        absUrl = new URL(href, baseUrl);
      } catch {
        continue;
      }
      if (!absUrl.toString().startsWith('http')) continue;
      // Track the largest `?at=N` we see — tuzac's windowed pager may
      // skip intermediate numbers (e.g. shows 1..5 then the last page);
      // we need to fan out to every page or the parser's gap-fill will
      // construct wrong `/N/` URLs that the server treats as page 1.
      const at = absUrl.searchParams.get('at');
      if (at && /^\d+$/.test(at)) {
        const n = parseInt(at, 10);
        if (Number.isFinite(n) && n > maxAt) maxAt = n;
      }
      // Capture the first link's URL parts as our gap-fill template.
      if (!templateOrigin) {
        templateOrigin = absUrl.origin;
        templatePathname = absUrl.pathname;
        templateSearch = absUrl.search;
      }
      const abs = absUrl.toString();
      // Skip the current-page link (re-renders as base + "#" or base + ?at=1).
      if (isCurrentPageLink(abs, baseUrl)) continue;
      out.add(abs);
    }
    // Fill gaps: emit `?at=N` for every N from 2..maxAt so the parser
    // visits every page (the paginator window only shows a few).
    if (maxAt >= 2 && templateOrigin) {
      for (let n = 2; n <= maxAt; n += 1) {
        const params = new URLSearchParams(templateSearch);
        params.set('at', String(n));
        out.add(
          `${templateOrigin}${templatePathname.replace(
            /\/$/,
            '',
          )}/?${params.toString()}`,
        );
      }
    }
    return Array.from(out);
  }

  /**
   * Pull only the gallery images (the ones rendered by the tuzac viewer).
   * Replaces the generic `<img>` extractor for this site so related-card
   * thumbnails and chrome icons don't pollute the result set.
   *
   * The `parseWebArticle` fallback (generic `<img>` extractor) only runs when
   * the adapter did not exist; once `extractImages` returns an empty array
   * (i.e. this page has no new content images), we skip the fallback so
   * constructed-URL pages (`/file/.../N/`) that re-render the same HTML do
   * not re-introduce related thumbs via the generic extractor.
   */
  extractImages(
    html: string,
    baseUrl: string,
    seen: Set<string>,
  ): TelegraphImage[] {
    const out: TelegraphImage[] = [];
    // Match `<div class="image-loading-box"><img …></div>` blocks. Each page
    // exposes up to 5 of these.
    const blockRe =
      /<div\b[^>]*class\s*=\s*["'][^"']*\bimage-loading-box\b[^"']*["'][^>]*>\s*<img\b([^>]*)\/?>/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) !== null) {
      const attrs = m[1] ?? '';
      // Prefer data-src then src (tuzac mirrors both for preview purposes).
      const url = pickAttr(attrs, 'data-src') || pickAttr(attrs, 'src');
      if (!url) continue;
      let absolute: string;
      try {
        absolute = new URL(url, baseUrl).toString();
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const photoNum = pickAttr(attrs, 'data-photo-num');
      const filename = deriveFilename(url, photoNum);
      out.push({
        id: `tuzac-${photoNum ?? absolute}`,
        index: out.length + 1,
        url: absolute,
        filename,
        selected: true,
      });
    }
    return out;
  }
}

function pickAttr(attrs: string, name: string): string | undefined {
  // Match `name="..."` or `name='...'`. Deliberately simple — these are
  // tuzac-controlled HTML and never have escaped quotes inside attr values.
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(attrs);
  return m ? m[1] : undefined;
}

function deriveFilename(url: string, photoNum: string | undefined): string {
  let base = 'tuzac.jpg';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) base = last;
  } catch {
    // fall through
  }
  return photoNum ? `${photoNum.padStart(3, '0')}_${base}` : base;
}

/**
 * Return true when `candidate` points at the same article page as `base` —
 * either an exact match, or a same-path `?at=1` link (tuzac's "current
 * page" anchor, which the pager always emits even when the user is
 * already there).
 */
function isCurrentPageLink(candidate: string, base: string): boolean {
  try {
    const c = new URL(candidate);
    const b = new URL(base);
    if (c.origin !== b.origin) return false;
    if (c.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '')) {
      return false;
    }
    // Same path: candidate is current iff its `at` query is absent or 1 AND
    // base's `at` is absent or 1.
    const at = (s: string) => {
      const v = new URL(s).searchParams.get('at');
      return v && /^\d+$/.test(v) ? parseInt(v, 10) : 1;
    };
    return at(candidate) === 1 && at(base) === 1;
  } catch {
    return false;
  }
}
