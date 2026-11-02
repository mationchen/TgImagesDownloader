/**
 * 图集页面上的「标签」。
 *
 * 实测（2026-11，抓的是用户真实下载过的站点）各站结构完全不同：
 *
 *   1. WordPress（everia.club，1y.is 同族）
 *        <div class="post-tags clr">
 *          <a href="https://everia.club/tag/cosplay/" rel="tag">Cosplay</a>
 *          <a href="https://everia.club/tag/xxx/" rel="tag">职业奶妈三水子</a>
 *        </div>
 *
 *   2. tuzac.com（自有模板，标签文字包在 <h2> 里）
 *        <div class="file-tags">
 *          <span id="tags_box_links">
 *            <a class="tag" href="/tags/xiuren"><h2>xiuren</h2></a>
 *
 *   3. 静态站（beidewuonline.github.io / pic4bei.github.io）
 *      没有标签系统，只有标题里的井号：
 *        #年年 - 沐浴 #漏点 #巨乳 [50P]
 *
 *   4. telegra.ph —— 完全没有标签，空数组就是正确答案。
 *
 * 所以这里按「容器 → 链接 → 标题井号 → meta keywords」逐级降级，命中即止。
 * 不做任何"从标题猜词"的推断：宁可空着，也不给用户塞假标签。
 */
import { decodeHtmlEntities } from '../utils/htmlEntities';

/** 单条记录最多保留多少个标签。 */
const MAX_TAGS = 20;
/** 单个标签的最大长度；超过的多半是一整句描述，直接丢掉。 */
const MAX_TAG_LEN = 20;

/**
 * 只有「整页找不到任何真实标签」时才会用 meta keywords 兜底，
 * 而 meta keywords 往往夹着站点 SEO 堆词，这里先滤掉通用词。
 * 注意：`无圣光` / `露点` 之类是 tuzac 的真实标签，不在过滤名单里。
 */
const KEYWORD_STOPLIST = new Set([
  '美女',
  '性感',
  '高清',
  '女神',
  '模特',
  '套图',
  '照片',
  '图片',
  '图集',
  '诱惑',
  '写放',
  'sexy',
  'sex',
  'porn',
  'nude',
  'beautiful',
  'girl',
  'model',
]);

/** 标签容器的起始标记（不会出现在 CSS 里，因为都带 `class="`）。 */
const CONTAINER_MARKERS = [
  'class="post-tags',
  "class='post-tags",
  'class="entry-tags',
  "class='entry-tags",
  'class="tags-links',
  "class='tags-links",
  'class="file-tags',
  "class='file-tags",
];

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

function normalize(raw: string): string {
  return decodeHtmlEntities(stripHtml(raw))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 收一个候选标签：去空白/实体/首尾标点，过滤纯数字与超长串，按小写去重。
 * `out` 达到上限后不再追加。
 */
function addTag(out: string[], seen: Set<string>, raw: string): void {
  if (out.length >= MAX_TAGS) return;
  const clean = normalize(raw)
    .replace(/^[#\s]+/, '')
    .replace(/[\s,，、;；|]+$/, '')
    .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
    .trim();
  if (!clean) return;
  if (clean.length > MAX_TAG_LEN) return;
  // 纯数字 / 纯日期（如 tuzac 的 7121、2023.07.21）不是标签
  if (!/[^\d\s.\-_/()]/.test(clean)) return;
  const key = clean.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(clean);
}

/** 只截取标签容器附近的一段 HTML，避免把侧边栏的标签云也收进来。 */
function tagContainerSlice(html: string): string {
  let start = -1;
  for (const marker of CONTAINER_MARKERS) {
    const i = html.indexOf(marker);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  if (start < 0) return '';
  // 容器一般只有几百字节；给 6KB 足够覆盖到结尾的 </div>。
  return html.slice(start, start + 6000);
}

function collectAnchors(
  html: string,
  anchor: RegExp,
  out: string[],
  seen: Set<string>,
): void {
  const re = new RegExp(anchor.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    addTag(out, seen, m[1] ?? '');
    if (out.length >= MAX_TAGS) return;
  }
}

/** `<a ... rel="tag">文本</a>`（WordPress 通用）。 */
const REL_TAG_ANCHOR =
  /<a\b[^>]*\brel\s*=\s*["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/;

/** `<a class="tag">…</a>`（tuzac；文字常包在 <h2> 里）。 */
const CLASS_TAG_ANCHOR =
  /<a\b[^>]*\bclass\s*=\s*["'](?:[^"']*\s+)?tag(?:\s+[^"']*)?["'][^>]*>([\s\S]{0,300}?)<\/a>/;

/** `href` 指向 /tag/ 或 /tags/ 的链接（其它 WordPress 变体）。 */
const TAG_HREF_ANCHOR =
  /<a\b[^>]*\bhref\s*=\s*["'][^"']*\/(?:tags?)\/[^"']*["'][^>]*>([\s\S]{0,300}?)<\/a>/;

/** 从任意文本里抽井号标签（静态站的标题就是这么写的）。 */
export function extractHashtags(raw: string): string[] {
  const text = decodeHtmlEntities(raw ?? '');
  const re = /#([^\s#<>"'[\]()（）,，。;；:：!！?？|/\\]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = (m[1] ?? '').trim();
    if (t) out.push(t);
  }
  return out;
}

/** 最后兜底：`<meta name="keywords">`，滤掉 SEO 堆词与纯数字。 */
function collectMetaKeywords(
  html: string,
  out: string[],
  seen: Set<string>,
): void {
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']keywords["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!content) continue;
    for (const part of decodeHtmlEntities(content[1]!).split(/[,，、;；|]/)) {
      const t = part.trim();
      if (!t) continue;
      if (KEYWORD_STOPLIST.has(t.toLowerCase())) continue;
      addTag(out, seen, t);
    }
    return;
  }
}

/**
 * 抽取一条记录的标签。
 *
 * @param html  图集页面的 HTML（拿不到就传空串，会退化成只用标题）
 * @param url   页面地址（目前只用于日志/未来站点特化，保留参数意义）
 * @param title 已知标题，用于静态站的井号标签
 */
export function extractTags(
  html: string,
  _url: string,
  title: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  // 1) 优先在标签容器里找：既准，又能避开侧边栏的标签云
  const container = tagContainerSlice(html);
  if (container) {
    collectAnchors(container, REL_TAG_ANCHOR, out, seen);
    if (out.length === 0) {
      collectAnchors(container, CLASS_TAG_ANCHOR, out, seen);
    }
    if (out.length === 0) {
      collectAnchors(container, TAG_HREF_ANCHOR, out, seen);
    }
  }

  // 2) 整页找 rel="tag"（没有容器标记的 WordPress 主题）
  if (out.length === 0 && html) {
    collectAnchors(html, REL_TAG_ANCHOR, out, seen);
  }
  // 3) 整页找 class="tag"
  if (out.length === 0 && html) {
    collectAnchors(html, CLASS_TAG_ANCHOR, out, seen);
  }
  // 4) 整页找 /tag/ 链接
  if (out.length === 0 && html) {
    collectAnchors(html, TAG_HREF_ANCHOR, out, seen);
  }
  // 5) 标题里的井号（静态站）
  if (out.length === 0 && title) {
    for (const tag of extractHashtags(title)) addTag(out, seen, tag);
  }
  // 6) meta keywords 兜底
  if (out.length === 0 && html) {
    collectMetaKeywords(html, out, seen);
  }

  return out.slice(0, MAX_TAGS);
}

export const _TAGS_INTERNALS = { MAX_TAGS, MAX_TAG_LEN, KEYWORD_STOPLIST };
