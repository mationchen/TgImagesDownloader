import {parseArticle, parseWebArticle} from '../src/services/telegraphParser';

// Mock global fetch so the parser can run without a network.
function mockFetchResponses(map: Record<string, {status: number; body: string}>) {
  (globalThis as any).fetch = jest.fn(async (url: any) => {
    const key = String(url);
    const entry = map[key] ?? map[new URL(key).pathname] ?? {
      status: 404,
      body: 'not found',
    };
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: {get: () => String(entry.body.length)},
      text: async () => entry.body,
    };
  }) as any;
}

const page1Html = `
<html><head><title>测试图集</title></head><body>
<article>
  <img src="https://karubox.top/wp-content/uploads/2026/08/REN08S202_1.webp">
  <img src="https://karubox.top/wp-content/uploads/2026/08/REN08S202_2.webp">
  <img class="wp-image-99" fifu-featured="1" src="https://itempura.airibox.top/thumb.webp">
</article>
<div class="page-links">
  <span>1</span>
  <a href="https://everia.club/2026/08/31/foo/2/">2</a>
  <a href="https://everia.club/2026/08/31/foo/3/">3</a>
</div>
</body></html>
`;

const page2Html = `
<html><head><title>测试图集</title></head><body>
<article>
  <img src="https://karubox.top/wp-content/uploads/2026/08/REN08S202_3.webp">
  <img src="https://karubox.top/wp-content/uploads/2026/08/REN08S202_4.webp">
</article>
<div class="page-links">
  <a href="https://everia.club/2026/08/31/foo/">1</a>
  <span>2</span>
</div>
</body></html>
`;

describe('parseWebArticle (generic pages + pagination)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('merges images across pages and filters related-post cards', async () => {
    const base = 'https://everia.club/2026/08/31/foo/';
    mockFetchResponses({
      'https://everia.club/2026/08/31/foo/': {status: 200, body: page1Html},
      'https://everia.club/2026/08/31/foo/2/': {status: 200, body: page2Html},
      'https://everia.club/2026/08/31/foo/3/': {status: 404, body: 'x'},
    });

    const res = await parseWebArticle(base);
    expect(res.ok).toBe(true);
    const article = res.article!;
    expect(article.title).toBe('测试图集');
    expect(article.source).toBe('web');
    expect(article.pageCount).toBe(2);
    // 4 content images across 2 pages; the related-post card (fifu-featured)
    // must be filtered out.
    const urls = article.images.map(i => i.url);
    expect(urls).toContain(
      'https://karubox.top/wp-content/uploads/2026/08/REN08S202_1.webp',
    );
    expect(urls).toContain(
      'https://karubox.top/wp-content/uploads/2026/08/REN08S202_4.webp',
    );
    expect(urls).toHaveLength(4);
    expect(urls.some(u => u.includes('airibox.top'))).toBe(false);
  });

  it('returns a single page when no pagination exists', async () => {
    const single = `
      <html><head><title>单页</title></head><body>
      <img src="https://cdn.example.com/a.jpg">
      <img src="https://cdn.example.com/b.jpg">
      </body></html>
    `;
    mockFetchResponses({
      'https://example.com/post/': {status: 200, body: single},
    });
    const res = await parseWebArticle('https://example.com/post/');
    expect(res.ok).toBe(true);
    expect(res.article!.images).toHaveLength(2);
    expect(res.article!.pageCount).toBe(1);
  });

  it('reports NO_IMAGES when a page has no images', async () => {
    mockFetchResponses({
      'https://example.com/empty/': {
        status: 200,
        body: '<html><body><p>no images</p></body></html>',
      },
    });
    const res = await parseWebArticle('https://example.com/empty/');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NO_IMAGES');
  });

  it('rejects SSRF URLs', async () => {
    const res = await parseWebArticle('http://127.0.0.1/x');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_URL');
  });

  it('routes telegra.ph URLs through parseArticle', async () => {
    const html = `<html><head><title>TG</title></head><body>
      <img src="https://telegra.ph/file/a.jpg"></body></html>`;
    mockFetchResponses({
      'https://telegra.ph/test': {status: 200, body: html},
    });
    const res = await parseArticle('https://telegra.ph/test');
    expect(res.ok).toBe(true);
    expect(res.article!.source).toBe('telegraph');
  });

  it('routes generic URLs through parseArticle', async () => {
    const html = `<html><head><title>Web</title></head><body>
      <img src="https://karubox.top/x.webp"></body></html>`;
    mockFetchResponses({
      'https://karubox.top/post': {status: 200, body: html},
    });
    const res = await parseArticle('https://karubox.top/post');
    expect(res.ok).toBe(true);
    expect(res.article!.source).toBe('web');
  });
});