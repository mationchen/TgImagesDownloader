import { parseWebArticle } from '../src/services/telegraphParser';

/**
 * 列表页（everia 首页 / page/N）的每张缩略图都带 `fifu-featured` / `post-id`，
 * 这正是「相关文章卡片」的标记；以前会被整页过滤成 0 张，误报「没有可下载的
 * 图片」。现在按结构判定为列表页后不再过滤。
 */
const LISTING_HTML = `
<html><head><title>Everia.club</title></head><body>
<div class="rt-col-md-4 rt-grid-item" data-id="1">
  <a class="tpg-post-link" href="https://everia.club/2026/11/07/a/">
    <img post-id="1" fifu-featured="1" width="400" height="600"
         src="https://remu.airibox.top/wp-content/uploads/2026/11/A_0.webp">
  </a>
</div>
<div class="rt-col-md-4 rt-grid-item" data-id="2">
  <a class="tpg-post-link" href="https://everia.club/2026/11/07/b/">
    <img post-id="2" fifu-featured="1" width="400" height="600"
         src="https://remu.airibox.top/wp-content/uploads/2026/11/B_0.webp">
  </a>
</div>
<div class="rt-col-md-4 rt-grid-item" data-id="3">
  <a class="tpg-post-link" href="https://everia.club/2026/11/07/c/">
    <img post-id="3" fifu-featured="1" width="400" height="600"
         src="https://remu.airibox.top/wp-content/uploads/2026/11/C_0.webp">
  </a>
</div>
<div class="page-links"><a href="/page/2/">2</a><a href="/page/3/">3</a></div>
</body></html>
`;

/** 文章页：正文图不带标记，相关推荐卡片带 post-id，必须继续过滤。 */
const ARTICLE_HTML = `
<html><head><title>某图集 – Everia.club</title></head><body>
<div class="entry-content">
  <img src="https://remu.airibox.top/wp-content/uploads/2026/11/A_1.webp" class="wp-image-1">
  <img src="https://remu.airibox.top/wp-content/uploads/2026/11/A_2.webp" class="wp-image-2">
  <img src="https://remu.airibox.top/wp-content/uploads/2026/11/A_3.webp" class="wp-image-3">
</div>
<div class="related">
  <img post-id="91" fifu-featured="1" src="https://karubox.top/wp-content/uploads/2026/10/R1_0.webp">
  <img post-id="92" fifu-featured="1" src="https://karubox.top/wp-content/uploads/2026/10/R2_0.webp">
  <img post-id="93" fifu-featured="1" src="https://karubox.top/wp-content/uploads/2026/10/R3_0.webp">
</div>
</body></html>
`;

function mockFetch(html: string) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => html,
  });
}

describe('everia 列表页与文章页', () => {
  afterEach(() => jest.restoreAllMocks());

  it('列表页：带 fifu-featured/post-id 的缩略图不再被整页过滤掉', async () => {
    const fetchMock = mockFetch(LISTING_HTML);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await parseWebArticle('https://everia.club/');

    expect(res.ok).toBe(true);
    expect(res.article?.images.length).toBe(3);
    // 列表页不再顺着分页抓（那是「在线图集」的事）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('文章页：正文图保留，相关推荐卡片仍然被过滤', async () => {
    const fetchMock = mockFetch(ARTICLE_HTML);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await parseWebArticle('https://everia.club/2026/11/07/a/');

    expect(res.ok).toBe(true);
    const urls = res.article?.images.map(i => i.url) ?? [];
    expect(urls).toHaveLength(3);
    expect(urls.every(u => u.includes('/A_'))).toBe(true);
  });
});
