import {
  MAX_PAGES,
  pageUrl,
  parseEveriaListing,
} from '../src/services/everiaListing';

/**
 * 真实站点的结构（The Post Grid 插件，2026-11 实测）的最小样本：
 * 每个条目 = rt-grid-item 块，里面有 h3.entry-title 的链接与一张 img。
 */
const HTML = `
<div class="rt-row rt-content-loader">
<div class="rt-col-md-4 rt-col-sm-6 rt-col-xs-12 default rt-grid-item" data-id="285930">
	<div class="rt-holder tpg-post-holder ">
		<div class="rt-detail rt-el-content-wrapper">
			<div class="rt-img-holder tpg-el-image-wrap has-thumbnail">
				<a data-id="285930" href="https://everia.club/2026/11/02/cosplay-%e8%81%8c%e4%b8%9a/" class="tpg-post-link" target="_self">
					<img post-id="285930" fifu-featured="1" src="https://reiobox.top/wp-content/uploads/2026/11/COS01P035_00.webp"
						 class="rt-img-responsive" width="400" height="600"
						 alt="Cosplay 职业奶妈三水子 &#8211; 束缚巫女">
				</a>
			</div>
			<div class="entry-title-wrapper"><h3 class="entry-title"><a data-id="285930" href="https://everia.club/2026/11/02/cosplay-%e8%81%8c%e4%b8%9a/" class="tpg-post-link" target="_self">Cosplay 职业奶妈三水子 &#8211; 束缚巫女</a></h3></div>
		</div>
	</div>
</div>

<div class="rt-col-md-4 rt-col-sm-6 rt-col-xs-12 default rt-grid-item" data-id="285927">
	<div class="rt-holder tpg-post-holder ">
		<div class="rt-detail rt-el-content-wrapper">
			<div class="rt-img-holder tpg-el-image-wrap has-thumbnail">
				<a data-id="285927" href="https://everia.club/2026/11/02/cosplay-pyon/" class="tpg-post-link" target="_self">
					<img post-id="285927" src="https://reiobox.top/wp-content/uploads/2026/11/COS01P033_0.webp" class="rt-img-responsive" alt="Cosplay Pyon">
				</a>
			</div>
			<div class="entry-title-wrapper"><h3 class="entry-title"><a data-id="285927" href="https://everia.club/2026/11/02/cosplay-pyon/" class="tpg-post-link" target="_self">Cosplay Pyonピオン – Fox Cutie</a></h3></div>
		</div>
	</div>
</div>

<div class="rt-col-md-4 rt-col-sm-6 rt-col-xs-12 default rt-grid-item" data-id="285930">
	<div class="rt-detail"><div class="entry-title-wrapper"><h3 class="entry-title"><a href="https://everia.club/2026/11/02/cosplay-%e8%81%8c%e4%b8%9a/" class="tpg-post-link">重复条目</a></h3></div></div>
</div>
</div>
`;

describe('parseEveriaListing', () => {
  it('抽取出 URL / 标题 / 预览图', () => {
    const list = parseEveriaListing(HTML);
    expect(list).toHaveLength(2);
    expect(list[0].url).toBe(
      'https://everia.club/2026/11/02/cosplay-%e8%81%8c%e4%b8%9a/',
    );
    expect(list[0].preview).toBe(
      'https://reiobox.top/wp-content/uploads/2026/11/COS01P035_00.webp',
    );
    // HTML 实体要解码成真实字符（&#8211; → –）
    expect(list[0].title).toContain('–');
    expect(list[1].title).toBe('Cosplay Pyonピオン – Fox Cutie');
  });

  it('同一个 URL 出现多次只保留一条', () => {
    const list = parseEveriaListing(HTML);
    const urls = list.map(e => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('空 HTML / 无条目时返回空数组', () => {
    expect(parseEveriaListing('')).toEqual([]);
    expect(parseEveriaListing('<html><body>nothing</body></html>')).toEqual([]);
  });
});

describe('pageUrl', () => {
  it('第 1 页是站点根，其余是 /page/N/', () => {
    expect(pageUrl(1)).toBe('https://everia.club/');
    expect(pageUrl(2)).toBe('https://everia.club/page/2/');
    expect(pageUrl(10)).toBe('https://everia.club/page/10/');
  });

  it('页码范围被夹在 1..MAX_PAGES', () => {
    expect(pageUrl(0)).toBe('https://everia.club/');
    expect(pageUrl(99)).toBe(`https://everia.club/page/${MAX_PAGES}/`);
  });
});
