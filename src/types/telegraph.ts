export interface TelegraphArticle {
  url: string;
  title: string;
  images: TelegraphImage[];
  parsedAt: number;
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
