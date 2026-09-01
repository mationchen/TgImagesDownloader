import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {
  computeSummary,
  downloadReducer,
  type DownloadState,
} from './downloadReducer';
import {
  createQueue,
  type QueueController,
  type TaskOutcome,
  type TaskRunner,
} from './downloadQueue';
import type {TelegraphArticle, TelegraphImage} from '../types/telegraph';
import {downloadImageToMediaStore} from '../services/imageDownloader';
import {
  ensureNotificationPermission,
  isNotifierSupported,
  notifyDownloadFinished,
  notifyDownloadProgress,
  notifyDownloadStart,
  notifyDownloadStop,
} from '../services/downloadNotifier';
import {APP_CONFIG} from '../constants/config';
import {sanitizeFilename} from '../utils/filename';

interface DownloadContextValue {
  state: DownloadState;
  summary: ReturnType<typeof computeSummary>;
  start: (article: TelegraphArticle, images: TelegraphImage[]) => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  retryFailed: () => void;
  setConcurrency: (n: number) => void;
  concurrency: number;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

interface ProviderProps {
  children: React.ReactNode;
  initialConcurrency?: number;
}

export const DownloadProvider: React.FC<ProviderProps> = ({
  children,
  initialConcurrency = APP_CONFIG.download.defaultConcurrency,
}) => {
  const [state, dispatch] = useReducer(downloadReducer, undefined, () => ({
    article: {url: '', title: '', images: [], parsedAt: 0},
    subfolder: 'untitled',
    tasks: {},
    taskOrder: [],
    isPaused: false,
    isRunning: false,
    rev: 0,
  }));

  const concurrencyRef = useRef(initialConcurrency);
  const setConcurrency = useCallback((n: number) => {
    concurrencyRef.current = clampConcurrency(n);
  }, []);

  const queueRef = useRef<QueueController | null>(null);

  // Read latest state from a ref so the queue's getState closure always
  // sees fresh data without re-creating the controller.
  const stateRef = useRef(state);
  stateRef.current = state;

  const buildRunner = useCallback((): TaskRunner => {
    return async (image, subfolder, ctx) => {
      // Translate DownloadOutcome -> TaskOutcome so the queue doesn't have
      // to know about MediaStore / blob-util specifics.
      const r = await downloadImageToMediaStore(image, subfolder, {
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      });
      if (ctx.signal.aborted) {
        return {kind: 'cancelled'} satisfies TaskOutcome;
      }
      if (r.kind === 'success') {
        return {
          kind: 'success',
          localPath: r.result.uri,
          bytes: r.result.bytes,
        };
      }
      if (r.kind === 'skipped') {
        return {kind: 'skipped', reason: r.reason};
      }
      return {kind: 'failed', code: r.code, message: r.message};
    };
  }, []);

  // Throttle progress notifications so we don't spam NotificationManager.
  const lastNotifyRef = useRef(0);
  const notifyStartedForRef = useRef<{title: string; total: number} | null>(null);

  const start = useCallback(
    (article: TelegraphArticle, images: TelegraphImage[]) => {
      const subfolder = sanitizeFilename(article.title, 80) || 'untitled';
      dispatch({type: 'init', article, images, subfolder});

      // Kick off a foreground service + progress notification (spec §20/§21).
      if (isNotifierSupported() && images.length > 0) {
        notifyStartedForRef.current = {title: article.title, total: images.length};
        ensureNotificationPermission().then(granted => {
          if (granted) {
            notifyDownloadStart(article.title, images.length);
            lastNotifyRef.current = Date.now();
          }
        });
      }

      // Build the queue against the *next* state; we let the queue read
      // from stateRef so we don't have to wait for the reducer to apply.
      queueRef.current?.cancel();
      const q = createQueue({
        getState: () => stateRef.current,
        dispatch: a => dispatch(a),
        runTask: buildRunner(),
        getConcurrency: () => concurrencyRef.current,
      });
      queueRef.current = q;
      // The `init` dispatch above hasn't flushed yet; defer start a tick so
      // getState() in the queue picks up the new task list.
      Promise.resolve().then(() => q.start());
    },
    [buildRunner],
  );

  const pause = useCallback(() => queueRef.current?.pause(), []);
  const resume = useCallback(() => queueRef.current?.resume(), []);
  const cancel = useCallback(() => {
    queueRef.current?.cancel();
    notifyDownloadStop();
    notifyStartedForRef.current = null;
  }, []);

  const retryFailed = useCallback(() => {
    // Re-arm every failed task by emitting init-like patches inline.
    const failedIds = stateRef.current.taskOrder.filter(
      id => stateRef.current.tasks[id]?.status === 'failed',
    );
    if (failedIds.length === 0) return;
    // Re-init keeps types clean; we rebuild the queue with only failed tasks.
    const failedImages = stateRef.current.taskOrder
      .map(id => stateRef.current.tasks[id])
      .filter(
        (t): t is NonNullable<typeof t> =>
          t != null && t.status === 'failed',
      )
      .map(t => {
        const img = stateRef.current.article.images.find(i => i.id === t.id);
        if (!img) return null;
        return {...img, selected: true};
      })
      .filter((img): img is TelegraphImage => img != null);
    if (failedImages.length === 0) return;
    start(stateRef.current.article, failedImages);
  }, [start]);

  const summary = useMemo(() => computeSummary(state), [state]);

  // Drive the foreground notification from queue state (spec §21):
  //   - running  -> throttled progress updates
  //   - finished -> completion summary, then auto-stop after a delay
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isNotifierSupported()) return;
    if (!notifyStartedForRef.current) return;

    if (summary.finished) {
      notifyDownloadFinished(
        summary.success,
        summary.failed,
        summary.skipped,
      );
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      // Let the user see the summary for a few seconds, then dismiss.
      stopTimerRef.current = setTimeout(() => {
        notifyDownloadStop();
        notifyStartedForRef.current = null;
      }, 5000);
      return;
    }

    if (state.isPaused) return;
    // Throttle progress updates to ~500ms to avoid spamming the OS.
    const now = Date.now();
    if (now - lastNotifyRef.current < 500) return;
    lastNotifyRef.current = now;
    const done = summary.success + summary.skipped + summary.failed + summary.cancelled;
    notifyDownloadProgress(done, summary.total);
  }, [summary, state.isPaused]);

  // Clean up timers on unmount.
  useEffect(
    () => () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    },
    [],
  );

  const value = useMemo<DownloadContextValue>(
    () => ({
      state,
      summary,
      start,
      pause,
      resume,
      cancel,
      retryFailed,
      setConcurrency,
      concurrency: concurrencyRef.current,
    }),
    [state, summary, start, pause, resume, cancel, retryFailed, setConcurrency],
  );

  return (
    <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>
  );
};

export function useDownload(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) {
    throw new Error('useDownload must be used inside <DownloadProvider>');
  }
  return ctx;
}

function clampConcurrency(n: number): number {
  const opts = APP_CONFIG.download.concurrencyOptions;
  const v = Math.max(opts[0], Math.min(opts[opts.length - 1], Math.floor(n)));
  return v;
}