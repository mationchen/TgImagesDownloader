import { extractHashtags, extractTags } from '../src/services/tags';

/**
 * 下面三段 HTML 都是 2026-11 从用户真实下载过的站点上抓下来的原文片段
 * （只去掉了无关的大段内容），不是凭空构造的：
 *   - EVERIA: https://everia.club/2026/11/02/cosplay-.../
 *   - TUZAC : https://www.tuzac.com/file/xr-uncensored-.../ae3f17...
 *   - 标题式: beidewuonline.github.io / pic4bei.github.io 的 h2
 */
const EVERIA_HTML = `
<div class="post-tags clr">
  <span class="owp-tag-texts">Tags</span>:
  <a href="https://everia.club/tag/cosplay/" rel="tag">Cosplay</a><span class="owp-sep">,</span>
  <a href="https://everia.club/tag/%e8%81%8c%e4%b8%9a/" rel="tag">职业奶妈三水子</a>
</div>
<div class="entry-content clr" itemprop="text">Cosplay 职业奶妈三水子 &#8211; 束缚巫女</div>
`;

const TUZAC_HTML = `
<div class="file-tags">
  <span class="not-in-mobile">类别:</span>
  <span id="tags_box_links">
    <a class="tag" href="/tags/xiuren"><h2>xiuren</h2></a>
    <a class="tag" href="/tags/%E7%A7%80%E4%BA%BA%E7%BD%91"><h2>秀人网</h2></a>
    <a class="tag" href="/tags/%E5%B9%BC%E5%B9%BC"><h2>幼幼</h2></a>
    <a class="tag" href="/tags/%E6%97%A0%E5%9C%A3%E5%85%89"><h2>无圣光</h2></a>
  </span>
</div>
`;

describe('extractTags — 各站点真实结构', () => {
  it('everia：WordPress 的 rel="tag"，且在标签容器里', () => {
    expect(extractTags(EVERIA_HTML, 'https://everia.club/x/', '标题')).toEqual([
      'Cosplay',
      '职业奶妈三水子',
    ]);
  });

  it('tuzac：a.tag 里的 <h2> 文本，标签文字要去掉标签只留内容', () => {
    expect(extractTags(TUZAC_HTML, 'https://www.tuzac.com/x', '标题')).toEqual([
      'xiuren',
      '秀人网',
      '幼幼',
      '无圣光',
    ]);
  });

  it('静态站：标题里的井号标签（不联网也能拿到）', () => {
    expect(extractTags('', 'https://beidewuonline.github.io/x.html', '#年年 - 沐浴 #漏点 #巨乳 [50P]')).toEqual([
      '年年',
      '漏点',
      '巨乳',
    ]);
  });

  it('telegra.ph：没有标签就是空数组，不能瞎猜', () => {
    const html =
      '<html><head><title>橙子喵酱 橙子法式修过 – Telegraph</title></head>' +
      '<body><h1>橙子喵酱 橙子法式修过</h1><p>正文</p></body></html>';
    expect(extractTags(html, 'https://telegra.ph/x', '橙子喵酱 橙子法式修过')).toEqual([]);
  });
});

describe('extractTags — 兜底与清洗', () => {
  it('没有链接时用 meta keywords，并滤掉 SEO 堆词与纯数字', () => {
    const html =
      '<html><head><meta name="keywords" content="美女, 性感, 幼幼, 秀人网, 7121, 高清, 无圣光" /></head><body></body></html>';
    expect(extractTags(html, 'https://example.com/x', '标题')).toEqual([
      '幼幼',
      '秀人网',
      '无圣光',
    ]);
  });

  it('有真实标签时不会退到 meta keywords', () => {
    const html =
      '<html><head><meta name="keywords" content="垃圾词" /></head>' +
      '<body><div class="post-tags"><a rel="tag" href="/tag/a">真标签</a></div></body></html>';
    expect(extractTags(html, 'https://example.com/x', '')).toEqual(['真标签']);
  });

  it('大小写无关去重', () => {
    const html = `
      <div class="post-tags">
        <a rel="tag" href="/tag/a">Cosplay</a>
        <a rel="tag" href="/tag/b">cosplay</a>
      </div>`;
    expect(extractTags(html, 'https://example.com/x', '')).toEqual(['Cosplay']);
  });

  it('侧边栏标签云不会被混进来（有容器时只看容器）', () => {
    const html = `
      <aside class="tagcloud"><a rel="tag" href="/tag/noise">侧栏噪音</a></aside>
      <div class="post-tags"><a rel="tag" href="/tag/real">正文标签</a></div>`;
    expect(extractTags(html, 'https://example.com/x', '')).toEqual(['正文标签']);
  });

  it('超过 20 个只保留前 20 个', () => {
    const links = Array.from(
      { length: 30 },
      (_, i) => `<a rel="tag" href="/tag/t${i}">标签${i}</a>`,
    ).join('');
    const tags = extractTags(
      `<div class="post-tags">${links}</div>`,
      'https://example.com/x',
      '',
    );
    expect(tags).toHaveLength(20);
  });

  it('整句描述（超长）与空串不会被当成标签', () => {
    const html = `
      <div class="post-tags">
        <a rel="tag" href="/tag/a">   </a>
        <a rel="tag" href="/tag/b">这是一整句非常长的描述文字根本不像标签所以不要它</a>
        <a rel="tag" href="/tag/c">幼幼</a>
      </div>`;
    expect(extractTags(html, 'https://example.com/x', '')).toEqual(['幼幼']);
  });

  it('HTML 实体要解码', () => {
    const html = `<div class="post-tags"><a rel="tag" href="/tag/a">A&amp;B &#8211; C</a></div>`;
    expect(extractTags(html, 'https://example.com/x', '')).toEqual(['A&B – C']);
  });
});

describe('extractHashtags', () => {
  it('抽中文井号，忽略方括号里的张数', () => {
    expect(extractHashtags('#铁手叫兽 - 阮阮 奶牛 #百合 #巨乳 #漏点 [50P]')).toEqual([
      '铁手叫兽',
      '百合',
      '巨乳',
      '漏点',
    ]);
  });

  it('没有井号时返回空数组', () => {
    expect(extractHashtags('普通标题')).toEqual([]);
  });
});
