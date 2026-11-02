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
