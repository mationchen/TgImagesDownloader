import type { TelegraphArticle, TelegraphImage } from '../types/telegraph';
import type { DownloadStatus, DownloadTask } from '../types/download';

/** Shape held in React state by the DownloadScreen via DownloadProvider. */
export interface DownloadState {
  article: TelegraphArticle;
  /** Full MediaStore RELATIVE_PATH shown in history / used for display. */
  subfolder: string;
  /**
   * The leaf subfolder actually handed to the native saver (empty string =
   * save directly under the app's base folder). Kept separate from
   * {@link subfolder} because the native module prepends its own base path.
   */
  subfolderLeaf: string;
  /**
   * Per-batch token (local HHMMSS) embedded in filenames so that downloads
   * landing in one shared folder never collide across batches.
   */
  batchToken: string;
  tasks: Record<string, DownloadTask>;
  taskOrder: string[];
  isPaused: boolean;
  isRunning: boolean;
  /** Monotonic counter bumped on every reducer dispatch; used to wake up the
   * queue controller from a pause. */
  rev: number;
}

export type DownloadAction =
  | {
      type: 'init';
      article: TelegraphArticle;
      images: TelegraphImage[];
      subfolder: string;
      subfolderLeaf: string;
    }
  | { type: 'task/started'; id: string; startedAt: number }
  | {
      type: 'task/progress';
      id: string;
      downloadedBytes: number;
      totalBytes: number;
    }
  | { type: 'task/success'; id: string; localPath: string }
  | { type: 'task/skipped'; id: string; reason: string }
  | { type: 'task/retrying'; id: string; attempt: number; nextDelayMs: number }
  | { type: 'task/failed'; id: string; errorCode: string; errorMessage: string }
  | { type: 'task/cancelled'; id: string }
  | { type: 'queue/paused' }
  | { type: 'queue/resumed' }
  | { type: 'queue/stopped' };

export function initDownloadState(
  article: TelegraphArticle,
  images: TelegraphImage[],
  subfolder: string,
  subfolderLeaf = '',
): DownloadState {
  const taskOrder: string[] = [];
  const tasks: Record<string, DownloadTask> = {};
  for (const img of images) {
    const task: DownloadTask = {
      id: img.id,
      imageId: String(img.index),
      status: 'pending' as DownloadStatus,
      progress: 0,
      retryCount: 0,
    };
    tasks[img.id] = task;
    taskOrder.push(img.id);
  }
  return {
    article,
    subfolder,
    subfolderLeaf,
    batchToken: batchTokenNow(),
    tasks,
    taskOrder,
    isPaused: false,
    isRunning: false,
    rev: 0,
  };
}

/** Local-time HHMMSS used to keep filenames unique across download batches. */
export function batchTokenNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function downloadReducer(
  state: DownloadState,
  action: DownloadAction,
): DownloadState {
  switch (action.type) {
    case 'init':
      return initDownloadState(
        action.article,
        action.images,
        action.subfolder,
        action.subfolderLeaf,
      );

    case 'task/started': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: { ...t, status: 'downloading', progress: 0 },
        },
      });
    }

    case 'task/progress': {
      const t = state.tasks[action.id];
      if (!t) return state;
      const progress =
        action.totalBytes > 0
          ? Math.max(
              0,
              Math.min(100, (action.downloadedBytes / action.totalBytes) * 100),
            )
          : t.progress;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: {
            ...t,
            downloadedBytes: action.downloadedBytes,
            totalBytes: action.totalBytes,
            progress,
          },
        },
      });
    }

    case 'task/success': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: {
            ...t,
            status: 'success',
            progress: 100,
            localPath: action.localPath,
          },
        },
      });
    }

    case 'task/skipped': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: {
            ...t,
            status: 'skipped',
            progress: 100,
            error: action.reason,
          },
        },
      });
    }

    case 'task/retrying': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: {
            ...t,
            status: 'pending',
            retryCount: action.attempt,
            error: `retrying in ${Math.round(action.nextDelayMs)}ms`,
          },
        },
      });
    }

    case 'task/failed': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: {
            ...t,
            status: 'failed',
            error: `${action.errorCode}: ${action.errorMessage}`,
          },
        },
      });
    }

    case 'task/cancelled': {
      const t = state.tasks[action.id];
      if (!t) return state;
      return bump(state, {
        ...state,
        tasks: {
          ...state.tasks,
          [action.id]: { ...t, status: 'cancelled' },
        },
      });
    }

    case 'queue/paused':
      return bump(state, { ...state, isPaused: true });
    case 'queue/resumed':
      return bump(state, { ...state, isPaused: false });
    case 'queue/stopped':
      return bump(state, { ...state, isRunning: false, isPaused: false });
    default:
      return state;
  }
}

function bump(state: DownloadState, next: DownloadState): DownloadState {
  return { ...next, rev: state.rev + 1 };
}

export interface DownloadSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  pending: number;
  downloading: number;
  paused: number;
  cancelled: number;
  finished: boolean;
  progressPercent: number;
}

export function computeSummary(state: DownloadState): DownloadSummary {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  let downloading = 0;
  let paused = 0;
  let cancelled = 0;
  let progressSum = 0;
  for (const id of state.taskOrder) {
    const t = state.tasks[id];
    if (!t) continue;
    switch (t.status) {
      case 'success':
        success += 1;
        progressSum += 100;
        break;
      case 'failed':
        failed += 1;
        progressSum += 0;
        break;
      case 'skipped':
        skipped += 1;
        progressSum += 100;
        break;
      case 'downloading':
        downloading += 1;
        progressSum += t.progress ?? 0;
        break;
      case 'paused':
        paused += 1;
        progressSum += t.progress ?? 0;
        break;
      case 'cancelled':
        cancelled += 1;
        progressSum += 0;
        break;
      case 'pending':
        pending += 1;
        progressSum += 0;
        break;
    }
  }
  const total = state.taskOrder.length;
  const finished =
    total > 0 && pending === 0 && downloading === 0 && paused === 0;
  const progressPercent = total > 0 ? Math.min(100, progressSum / total) : 0;
  return {
    total,
    success,
    failed,
    skipped,
    pending,
    downloading,
    paused,
    cancelled,
    finished,
    progressPercent,
  };
}
