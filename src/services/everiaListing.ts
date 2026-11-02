/**
 * 在线图集列表（everia.club 列表页）。
 *
 * 需求：从 https://everia.club/ 以及 /page/2..10/ 抓「文章链接 + 一张预览图」，
 * 供用户勾选后加入待下载列表。
 *
 * 页面结构（The Post Grid 插件，实测 2026-11）：
 *
 *   <div class="rt-col-md-4 ... rt-grid-item" data-id="285930">
 *     ...
 *     <a class="tpg-post-link" href="ARTICLE_URL">
 *       <img src="PREVIEW_URL" alt="TITLE">
 *     </a>
 *     <h3 class="entry-title"><a class="tpg-post-link" href="ARTICLE_URL">TITLE</a></h3>
 *
 * 解析方式：按 `rt-grid-item` 切成块，每块取「h3 里的 href / 标题」和「img 的 src」。
 * 用切块而不是全局 zip，避免广告位里多出一个 `<img>` 时整体错位。
 */
import { APP_CONFIG } from '../constants/config';
import { decodeHtmlEntities } from '../utils/htmlEntities';

export type ListingEntry = {
  /** 文章页地址（待下载 URL）。 */
  url: string;
  /** 文章标题（已解 HTML 实体）。 */
  title: string;
  /** 列表页上的封面图，用作预览。 */
  preview: string;
};

export type ListingFetchResult = {
  entries: ListingEntry[];
  /** 抓取失败的页码（部分失败时其它页照常返回）。 */
  failedPages: number[];
};

/** 站点根地址；第 1 页是 `/`，其余是 `/page/N/`。 */
const SITE_ROOT = 'https://everia.club';
/** 最多支持到第 10 页（需求明确「不用再多」）。 */
export const MAX_PAGES = 10;

export function pageUrl(page: number): string {
  const n = Math.max(1, Math.min(MAX_PAGES, Math.floor(page)));
  return n === 1 ? `${SITE_ROOT}/` : `${SITE_ROOT}/page/${n}/`;
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从列表页 HTML 里抽出条目（纯函数，便于单测）。
 * 没有标题或没有链接的块会被丢弃。
 */
export function parseEveriaListing(html: string): ListingEntry[] {
  if (!html) return [];
  // 按条目起点切块：每块 = 一个 rt-grid-item 到下一个之前。
  const chunks = html.split(/(?=<div class="rt-col-[^"]*rt-grid-item")/);
  const out: ListingEntry[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    if (!/rt-grid-item/.test(chunk)) continue;

    // 优先用 h3 里的链接（标题块一定存在）；退化时用第一个 tpg-post-link。
    const titleMatch =
      /<h3 class="entry-title">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
        chunk,
      );
    const hrefMatch = titleMatch ?? /class="tpg-post-link"[^>]*href="([^"]+)"/.exec(chunk) ??
      /href="([^"]+)"[^>]*class="tpg-post-link"/.exec(chunk);
    if (!hrefMatch) continue;

    const url = hrefMatch[1]!.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;

    const imgMatch = /<img[^>]+src="([^"]+)"/.exec(chunk);
    const preview = imgMatch ? imgMatch[1]!.trim() : '';

    const rawTitle = titleMatch ? stripTags(titleMatch[2] ?? '') : '';
    const altMatch = /<img[^>]+alt="([^"]*)"/.exec(chunk);
    const title = decodeHtmlEntities(
      rawTitle || (altMatch ? altMatch[1]! : '') || url,
    );

    seen.add(url);
    out.push({ url, title, preview });
  }

  return out;
}

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    APP_CONFIG.telegraph.readTimeoutMs,
  );
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': APP_CONFIG.telegraph.userAgent,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 单页失败重试的次数（移动网络下偶发超时很常见）。 */
const PAGE_ATTEMPTS = 3;
/** 页与页之间的间隔，避免同一站点被并发/连续请求触发限流。 */
const PAGE_GAP_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 抓取若干列表页并解析。
 *
 * **顺序**抓取而不是并发：实测 5 页同时发请求时全部超时（站点/移动网络会限流），
 * 单页重试却很快（1-3 秒）。所以这里逐页取、每页最多 {@link PAGE_ATTEMPTS} 次，
 * 单页彻底失败只记入 failedPages，不影响其它页。
 */
export async function fetchEveriaPages(
  pages: number[],
): Promise<ListingFetchResult> {
  const wanted = Array.from(
    new Set(pages.map(p => Math.max(1, Math.min(MAX_PAGES, Math.floor(p))))),
  ).sort((a, b) => a - b);
  if (wanted.length === 0) return { entries: [], failedPages: [] };

  const entries: ListingEntry[] = [];
  const failedPages: number[] = [];

  for (let i = 0; i < wanted.length; i += 1) {
    const page = wanted[i]!;
    let html = '';
    for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt += 1) {
      try {
        html = await fetchHtml(pageUrl(page));
        break;
      } catch (e) {
        console.log(
          `[listing] page ${page} attempt ${attempt} failed: ${String(e)}`,
        );
        if (attempt < PAGE_ATTEMPTS) await sleep(PAGE_GAP_MS * attempt);
      }
    }
    if (!html) {
      failedPages.push(page);
    } else {
      entries.push(...parseEveriaListing(html));
    }
    if (i < wanted.length - 1) await sleep(PAGE_GAP_MS);
  }

  return { entries, failedPages };
}
