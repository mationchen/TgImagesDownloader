import { HanimeComicAdapter } from '../src/services/adapters/hanimeComicAdapter';

/**
 * 真实页面片段（2026-11 从 https://hanimeone.me/comic/121142/1 抓下来）：
 * 图片前缀 + 扩展名 + 总页数都在页面上，整本地址可以直接拼出来。
 */
const HTML = `
<div class="no-select comic-show-content-nav" data-id="3032922" data-pages="239">
  <span class="current-page-number">1</span><span> / </span>239
  <a class="comic-show-content-nav-item-wrapper fast-forward"
     href="https://hanimeone.me/comic/121142/239" data-id="3032922" data-page="239">
</div>
<img id="current-page-image"
     src="https://i2.nhentai.net/galleries/3032922/1.jpg"
     data-extension="jpg"
     data-prefix="https://i2.nhentai.net/galleries/3032922/">
`;

describe('HanimeComicAdapter', () => {
  const adapter = new HanimeComicAdapter();

  it('只认漫画页', () => {
    expect(adapter.canHandle('https://hanimeone.me/comic/121142/1')).toBe(true);
    expect(adapter.canHandle('https://hanimeone.me/comic/121142')).toBe(true);
    expect(adapter.canHandle('https://hanime1.me/comic/121142/7')).toBe(true);
    // 不是漫画页 / 别的站
    expect(adapter.canHandle('https://hanimeone.me/video/121142')).toBe(false);
    expect(adapter.canHandle('https://example.com/comic/121142/1')).toBe(false);
  });

  it('按 data-prefix + data-pages 拼出整本 239 张', () => {
    // 整本在第 1 页就拼完：解析器不能再顺着链接翻页、也不该套用
    // 「每页 N 张 × 页数」的完整性公式（漫画是一页一张）。
    expect(adapter.wholeGalleryFromFirstPage).toBe(true);
    const images = adapter.extractImages(HTML, 'https://hanimeone.me/comic/121142/1', new Set());
    expect(images).toHaveLength(239);
    expect(images[0].url).toBe(
      'https://i2.nhentai.net/galleries/3032922/1.jpg',
    );
    expect(images[238].url).toBe(
      'https://i2.nhentai.net/galleries/3032922/239.jpg',
    );
    expect(images[0].index).toBe(1);
    expect(images[238].index).toBe(239);
    expect(images[0].filename).toBe('001.jpg');
  });

  it('声明倒序下载（相册顺序），且不逐页翻', () => {
    expect(adapter.downloadReverse).toBe(true);
    expect(adapter.paginationUrls()).toEqual([]);
  });

  it('同一个 seen 里不会重复产出', () => {
    const seen = new Set<string>();
    const first = adapter.extractImages(HTML, 'https://x', seen);
    const second = adapter.extractImages(HTML, 'https://x', seen);
    expect(first).toHaveLength(239);
    expect(second).toHaveLength(0);
  });

  it('页面缺少前缀或页数时返回空数组（不要瞎猜）', () => {
    expect(adapter.extractImages('<img id="current-page-image">', 'x', new Set())).toEqual([]);
    expect(
      adapter.extractImages(
        '<img id="current-page-image" data-prefix="https://a/b/">',
        'x',
        new Set(),
      ),
    ).toEqual([]);
  });
});
