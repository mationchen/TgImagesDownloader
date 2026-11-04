import type { TelegraphImage } from '../../types/telegraph';
import type { SiteAdapter } from './types';

/**
 * hanimeone.me（Hanime1 镜像）的**漫画**页：`/comic/<galleryId>/<page>`。
 *
 * 页面结构（2026-11 实测）：
 *
 *   <img id="current-page-image"
 *        src="https://i2.nhentai.net/galleries/3032922/1.jpg"
 *        data-extension="jpg"
 *        data-prefix="https://i2.nhentai.net/galleries/3032922/">
 *   <div class="comic-show-content-nav" data-id="3032922" data-pages="239">
 *
 * 也就是说：**整本的图片地址可以直接拼出来**（前缀 + 页码 + 扩展名），
 * 不需要真的去翻 239 次页面。通用解析器只认得页面里那些推荐位缩略图
 * （20 张左右），所以之前只能解析出二十来张。
 *
 * 另外一个和普通图集不同的点：漫画要「从最后一页开始下」，见
 * `downloadReverse` —— 相册按保存时间倒序展示，倒着下才能让第 1 页排在最前。
 */
export class HanimeComicAdapter implements SiteAdapter {
  readonly name = 'hanime-comic';

  /**
   * 声明这本图集必须**串行下载**（并发 1）：漫画相邻页顺序敏感，并发会让
   * 完成顺序互换。派发顺序由 DownloadContext 统一倒序，这里不负责排序。
   */
  readonly downloadReverse = true;

  /**
   * `/comic/121142` 这种不带页码的地址返回的是 12 万字节的**详情页**，里面没有
   * `current-page-image`；必须补成 `/comic/121142/1` 才是真正的阅读页。
   */
  normalizeUrl(url: string): string {
    // 只处理路径形如 /comic/<id>（可带结尾斜杠）的地址；其它一律原样返回。
    // 注意：RN 的 URL 类型里 pathname 是只读的，这里用字符串替换实现。
    if (/^https?:\/\/[^/]+\/comic\/\d+\/?(?:[?#]|$)/i.test(url)) {
      return url.replace(/(\/comic\/\d+)\/?(?=[?#]|$)/i, '$1/1');
    }
    return url;
  }

  canHandle(url: string): boolean {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (
        host !== 'hanimeone.me' &&
        host !== 'www.hanimeone.me' &&
        host !== 'hanime1.me' &&
        host !== 'www.hanime1.me'
      ) {
        return false;
      }
      // /comic/121142 或 /comic/121142/1
      return /^\/comic\/\d+(?:\/\d+)?\/?$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  /** 整本一次解析完，不用逐页翻（逐页抓 239 次又慢又容易被限流）。 */
  paginationUrls(): string[] {
    return [];
  }

  extractImages(
    html: string,
    _baseUrl: string,
    seen: Set<string>,
  ): TelegraphImage[] {
    const imgTag =
      /<img\b[^>]*\bid\s*=\s*["']current-page-image["'][^>]*>/i.exec(html)?.[0] ??
      '';
    const attr = (name: string): string => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(
        imgTag,
      );
      return (m?.[1] ?? '').trim();
    };

    const prefix = attr('data-prefix');
    const ext = (attr('data-extension') || 'jpg').replace(/^\./, '');
    // 总页数在导航条上：<div class="comic-show-content-nav" data-pages="239">
    const pages = Number(
      /\bdata-pages\s*=\s*["'](\d+)["']/i.exec(html)?.[1] ?? 0,
    );
    if (!prefix || !Number.isFinite(pages) || pages <= 0) return [];
    // 防御：万一站点给了个离谱的数字，别把任务队列撑爆。
    const total = Math.min(pages, 2000);

    const out: TelegraphImage[] = [];
    for (let i = 1; i <= total; i += 1) {
      const url = `${prefix}${i}.${ext}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        id: `hanime-${i}`,
        index: i,
        url,
        filename: `${String(i).padStart(3, '0')}.${ext}`,
        selected: true,
      });
    }
    return out;
  }
}
