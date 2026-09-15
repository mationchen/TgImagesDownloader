import { TuzacAdapter } from '../src/services/adapters/tuzacAdapter';

const ADAPTER = new TuzacAdapter();

// Minimal HTML fragment that mirrors tuzac.com's content + decorative markup.
const HTML = `
<html><body>
  <img src="/theme/jw/logo.png" alt="logo">
  <img src="/theme/jw/images/upload-icon.svg" alt="up">

  <div class="image-loading-box"><img src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQ323-0.jpg" data-src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQ323-0.jpg" data-photo-num="1" alt="x" loading="lazy"></div>
  <div class="image-loading-box"><img src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZT056-1.jpg" data-src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZT056-1.jpg" data-photo-num="2" alt="x" loading="lazy"></div>
  <div class="image-loading-box"><img src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQO0-2.jpg" data-src="https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQO0-2.jpg" data-photo-num="3" alt="x" loading="lazy"></div>

  <div class="related"><img src="https://image.tuzac.com/jw-photos/related/x-9.jpg" alt="related"></div>
</body></html>
`;

describe('adapters/TuzacAdapter', () => {
  it('canHandle matches www.tuzac.com and bare tuzac.com', () => {
    expect(ADAPTER.canHandle('https://www.tuzac.com/file/abc/123/')).toBe(true);
    expect(ADAPTER.canHandle('https://tuzac.com/file/abc/123/?at=5')).toBe(
      true,
    );
  });

  it('canHandle rejects other hosts', () => {
    expect(ADAPTER.canHandle('https://example.com/abc')).toBe(false);
    expect(ADAPTER.canHandle('https://tuzac.com.evil.example/x')).toBe(false);
  });

  it('extracts only images inside image-loading-box, in order', () => {
    const seen = new Set<string>();
    const imgs = ADAPTER.extractImages(HTML, 'https://www.tuzac.com/x/', seen);
    expect(imgs).toHaveLength(3);
    expect(imgs.map(i => i.url)).toEqual([
      'https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQ323-0.jpg',
      'https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZT056-1.jpg',
      'https://image.tuzac.com/jw-photos/qqc/A-37P-/120ZQO0-2.jpg',
    ]);
    // seen only contains the 3 content URLs (no decorative/noise) — the
    // parser-side `extractWithAdapter` skips the generic fallback when the
    // adapter returns an empty array, so the adapter never marks chrome
    // icons / related thumbs as seen. They wouldn't be re-emitted as content
    // images on subsequent pages anyway.
    expect(seen.size).toBe(3);
    expect(seen.has(imgs[0]!.url)).toBe(true);
  });

  it('prefixes filename with the data-photo-num for ordering', () => {
    const imgs = ADAPTER.extractImages(
      HTML,
      'https://www.tuzac.com/x/',
      new Set<string>(),
    );
    expect(imgs.map(i => i.filename)).toEqual([
      '001_120ZQ323-0.jpg',
      '002_120ZT056-1.jpg',
      '003_120ZQO0-2.jpg',
    ]);
  });

  it('skips decorative images (logo, icons, related thumbs)', () => {
    // Without the adapter, the generic extractor would pick up logo.png,
    // upload-icon.svg and the related-thumb <img>. The adapter must ignore
    // all of those.
    const imgs = ADAPTER.extractImages(
      HTML,
      'https://www.tuzac.com/x/',
      new Set<string>(),
    );
    expect(imgs.find(i => i.url.endsWith('logo.png'))).toBeUndefined();
    expect(imgs.find(i => i.url.endsWith('upload-icon.svg'))).toBeUndefined();
    expect(imgs.find(i => i.url.endsWith('related/x-9.jpg'))).toBeUndefined();
  });

  it('dedupes within the same page', () => {
    // Same URL in two boxes (shouldn't happen but guard anyway).
    const html = HTML.replace(
      'data-photo-num="2"',
      'data-photo-num="2" data-photo-num="dup"',
    );
    const imgs = ADAPTER.extractImages(
      html,
      'https://www.tuzac.com/x/',
      new Set<string>(),
    );
    expect(imgs).toHaveLength(3);
  });

  it('returns TelegraphImage objects with id/index/url/filename/selected', () => {
    const imgs = ADAPTER.extractImages(
      HTML,
      'https://www.tuzac.com/x/',
      new Set<string>(),
    );
    for (let i = 0; i < imgs.length; i += 1) {
      const img = imgs[i]!;
      expect(typeof img.id).toBe('string');
      expect(img.index).toBe(i + 1);
      expect(typeof img.url).toBe('string');
      expect(typeof img.filename).toBe('string');
      expect(img.selected).toBe(true);
    }
  });

  it('paginationUrls scrapes ?at=N links and fills gaps up to the max', () => {
    const htmlWithPager = `<html><body>
      <div id="pager">
        <a href="#" class="page-curr">1</a>
        <a href="/file/tuigirl-37p/11700/?at=2" class="page-item">2</a>
        <a href="/file/tuigirl-37p/11700/?at=3" class="page-item">3</a>
        <a href="/file/tuigirl-37p/11700/?at=8" class="page-item">末页</a>
      </div>
    </body></html>`;
    const base = 'https://www.tuzac.com/file/tuigirl-37p/abc/?at=1';
    const urls = ADAPTER.paginationUrls(htmlWithPager, base);
    // maxAt seen in the pager is 8 (末页). The adapter fills in 2..8, so
    // pages 4..7 are reconstructed even though the pager window omitted
    // them. Critically, the gap-fill uses the FIRST pager link's origin +
    // pathname (`/file/tuigirl-37p/11700/`) as the template — NOT the
    // baseUrl's pathname `/file/tuigirl-37p/abc/`, which is a hash-style
    // URL the server treats as page 1.
    expect(urls.sort()).toEqual(
      [
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=2',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=3',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=4',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=5',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=6',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=7',
        'https://www.tuzac.com/file/tuigirl-37p/11700/?at=8',
      ].sort(),
    );
  });

  it('paginationUrls resolves hrefs relative to the base URL', () => {
    const html = `<html><body><div id="pager">
      <a href="/file/abc/123/?at=2">2</a>
      <a href="?at=3">3</a>
    </div></body></html>`;
    const base = 'https://www.tuzac.com/some-base/';
    const urls = ADAPTER.paginationUrls(html, base);
    // The first pager link sets the gap-fill template to
    // `/file/abc/123/?at=2`; the relative href `?at=3` resolves against
    // the base URL (`/some-base/`). Both end up in the result; the
    // gap-fill fills 2..3 using the first link's path.
    expect(urls.sort()).toEqual(
      [
        'https://www.tuzac.com/file/abc/123/?at=2',
        'https://www.tuzac.com/file/abc/123/?at=3',
        'https://www.tuzac.com/some-base/?at=3',
      ].sort(),
    );
  });

  it('paginationUrls returns [] when the pager block is absent', () => {
    expect(
      ADAPTER.paginationUrls(
        '<html><body>no pager here</body></html>',
        'https://www.tuzac.com/x/',
      ),
    ).toEqual([]);
  });
});
