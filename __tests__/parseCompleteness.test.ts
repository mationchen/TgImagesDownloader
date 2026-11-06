import { parseWebArticle } from '../src/services/telegraphParser';

/**
 * 漫画页（hanimeone.me/comic/<id>/<page>）的真实结构片段：
 * 第 1 页就带 data-prefix + data-pages，整本地址可以一次拼出来。
 */
const COMIC_HTML = `
<html><head><title>第1頁 - 測試漫畫</title></head><body>
<div class="no-select comic-show-content-nav" data-id="3032922" data-pages="366">
  <span class="current-page-number">1</span><span> / </span>366
  <a class="comic-show-content-nav-item-wrapper fast-forward"
     href="https://hanimeone.me/comic/119015/366" data-page="366">366</a>
</div>
<img id="current-page-image"
     src="https://i2.nhentai.net/galleries/3032922/1.jpg"
     data-extension="jpg"
     data-prefix="https://i2.nhentai.net/galleries/3032922/">
</body></html>
`;

function fakeFetch(html: string) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => html,
  });
}

/** 20 张图 + 分页链接（形如 /gallery/2/、/gallery/3/）。 */
function galleryHtml(page: number, pages: number): string {
  const imgs = Array.from({ length: 20 })
    .map(
      (_, i) =>
        `<img src="https://img.example.com/p${page}/${i + 1}.jpg" alt="gallery">`,
    )
    .join('\n');
  const links = Array.from({ length: pages })
    .map((_, i) => `<a href="/gallery/${i + 1}/">${i + 1}</a>`)
    .join(' ');
  return `<html><head><title>測試圖集</title></head><body>
<div class="page-links">${links}</div>
${imgs}
</body></html>`;
}

describe('parseWebArticle 完整性检查', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('漫画整本一次拼完：不翻页、不套「每页 N 张」公式（回归 133591 张误报）', async () => {
    const fetchMock = fakeFetch(COMIC_HTML);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await parseWebArticle('https://hanimeone.me/comic/119015/1');

    expect(res.ok).toBe(true);
    expect(res.article?.images).toHaveLength(366);
    // 漫画是一页一张图，「每页张数 × 页数」模型不成立，不能给缺页提示。
    expect(res.article?.imageCountHint).toBeUndefined();
    // 整本已拼完，只应该发 1 个请求（不顺着阅读器链接去翻页）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('普通多页图集：某页网络失败且张数不足时给出区间提示', async () => {
    // 第 1、2 页正常（各 20 张），第 3 页起始终失败。
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      const page = Number(/(\d+)\/?$/.exec(url)?.[1] ?? '1');
      if (page >= 3) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => galleryHtml(page, 3),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await parseWebArticle('https://example.com/gallery/');

    expect(res.ok).toBe(true);
    // 20 张 × 2 页已取到，第 3 页缺 → 应有 41–60 张
    expect(res.article?.images.length).toBe(40);
    expect(res.article?.imageCountHint).toEqual({ min: 41, max: 60 });
  });
});
