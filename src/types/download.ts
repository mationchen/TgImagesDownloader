export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface DownloadTask {
  id: string;
  imageId: string;
  status: DownloadStatus;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  retryCount: number;
  localPath?: string;
  error?: string;
}

export interface DownloadSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}
