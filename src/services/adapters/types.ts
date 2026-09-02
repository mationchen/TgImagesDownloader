import type {TelegraphImage} from '../../types/telegraph';

/**
 * SiteAdapter — per-site page parsing strategy.
 * Mirrors the Resolver pattern: a small, composable unit that owns one site's quirks.
 * The Generic adapter is the fallback; site-specific adapters override pagination
 * and/or extraction when the generic heuristics miss.
 */
export interface SiteAdapter {
  readonly name: string;
  /** True when this adapter should handle the given page URL (and optional HTML hint). */
  canHandle(url: string, html?: string): boolean;
  /**
   * Return pagination URLs discovered on this page.
   * Empty array means “no pagination”. The parser will treat the page as single.
   * Implementations may return relative or absolute URLs; the caller resolves them.
   */
  paginationUrls(html: string, baseUrl: string): string[];
  /**
   * Optional site-specific image extraction. When not provided, the generic
   * `extractImages` pipeline is used. When provided, its results are merged
   * into the shared `seen` set before the generic pass (or it can replace it).
   * Return TelegraphImage[] already deduped against `seen`, or string[] of URLs.
   */
  extractImages?(
    html: string,
    baseUrl: string,
    seen: Set<string>,
    opts?: {skipRelatedCards?: boolean},
  ): TelegraphImage[] | string[];
}

export type AdapterFilter = (url: string, attrs: string) => boolean;
