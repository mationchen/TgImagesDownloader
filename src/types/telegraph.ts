export interface TelegraphArticle {
  url: string;
  title: string;
  images: TelegraphImage[];
  parsedAt: number;
  /** Page type: telegra.ph or a generic web page. */
  source?: 'telegraph' | 'web';
  /** How many pages were merged when the article spans multiple pages. */
  pageCount?: number;
  /**
   * 页面上的标签（v7+）。各站点结构不同，由 `services/tags.ts` 按
   * `rel="tag"` / `a.tag` / `/tag/` 链接 / 标题井号 / meta keywords 逐级提取。
   * 站点本来没有标签时为空数组（telegra.ph 就是这种）。
   */
  tags?: string[];
  /**
   * 解析结果里的 `images` 永远按「第 1 页 → 第 N 页」正序；下载队列会**倒序
   * 派发**（第 1 页最后写），这样相册按保存时间倒序展示时第 1 页在最前面。
   * 这个标记只表示「必须串行下载」（漫画），不影响排序。
   */
  downloadReverse?: boolean;
  /**
   * 分页完整性提示：按「每页张数 × 页数」估算应有张数，实际解析少于下限时给出
   * （min..max 为应有区间）。用于在预览页提醒「可能缺页，建议重新解析」。
   * 没有发现缺页时不存在这个字段。
   */
  imageCountHint?: { min: number; max: number };
}

export interface TelegraphImage {
  id: string;
  index: number;
  url: string;
  filename: string;
  mimeType?: string;
  width?: number;
  height?: number;
  selected: boolean;
}

export type ParseErrorCode =
  | 'INVALID_URL'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'HTTP_NOT_FOUND'
  | 'HTTP_FORBIDDEN'
  | 'HTTP_SERVER_ERROR'
  | 'PARSE_ERROR'
  | 'NO_IMAGES'
  | 'RESPONSE_TOO_LARGE'
  | 'UNKNOWN';

export interface ParseResult {
  ok: boolean;
  article?: TelegraphArticle;
  error?: {
    code: ParseErrorCode;
    message: string;
    detail?: string;
  };
}
