import type { ParseErrorCode } from './telegraph';

export type BatchItemStatus =
  /** Awaiting dispatch in the batch loop. */
  | 'pending'
  /** parseArticle is currently fetching/parsing the page. */
  | 'parsing'
  /** Images are being saved to MediaStore by the download queue. */
  | 'downloading'
  /** Successfully saved every image (and deduped skips). */
  | 'done'
  /** parseArticle returned 0 images, an error, or the runner threw. */
  | 'failed'
  /** User hit `⊘ 跳过当前` — terminally skipped. */
  | 'skipped';

export type BatchItem = {
  /** Original URL string. Also the React `key`. */
  url: string;
  /** Current lifecycle status. Drives badge + per-row color. */
  status: BatchItemStatus;
  /** Free-form reason shown in the row (`24 张`, `HTTP_404`, `0 张`, ...). */
  detail: string;
  /** Incremental download progress while status === 'downloading'. */
  progress: { cur: number; total: number } | null;
  /**
   * Set when this URL already has a row in the history DB at load time
   * (most recent successful batch). The scheduler skips these by default;
   * the user can manually re-queue by tapping the row to clear the flag.
   */
  existing?: {
    historyId: number;
    title: string;
    imageCount: number;
    status: string;
  };
};

export type BatchProgress = {
  /** Total items queued at the start of the run. */
  total: number;
  /** Count of items currently in `done`. */
  done: number;
  /** Count of items currently in `failed`. */
  failed: number;
  /** Count of items currently in `skipped`. */
  skipped: number;
  /** Index of the URL currently being processed (parsing or downloading). */
  currentIndex: number;
};

/** Last-error information kept on a single URL after a failure. */
export type BatchFailureReason = {
  /** The raw URL that failed. */
  url: string;
  /** Error code returned by parseArticle (or 'UNKNOWN' if thrown). */
  code: ParseErrorCode | 'UNKNOWN';
  /** Human-readable message for the toast summary. */
  message: string;
};
