import type { TelegraphImage } from '../../types/telegraph';

/**
 * SiteAdapter — per-site page parsing strategy.
 * Mirrors the Resolver pattern: a small, composable unit that owns one site's quirks.
 * The Generic adapter is the fallback; site-specific adapters override pagination
 * and/or extraction when the generic heuristics miss.
 */
export interface SiteAdapter {
  readonly name: string;
  /**
   * 可选：把用户粘贴的地址改写成真正要抓的地址。例如漫画详情页
   * `/comic/121142` 需要补成 `/comic/121142/1` 才有图片元素。
   */
  normalizeUrl?: (url: string) => string;
  /**
   * 声明这个站点的图集**必须串行下载**（并发 1）。漫画类需要：相册顺序靠
   * 写入时间，并发会让相邻页的完成顺序互换，读起来就串页。
   * 派发顺序对所有图集都是倒序（见 DownloadContext），这里只影响并发数。
   */
  readonly downloadReverse?: boolean;
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
    opts?: { skipRelatedCards?: boolean },
  ): TelegraphImage[] | string[];
}

export type AdapterFilter = (url: string, attrs: string) => boolean;
