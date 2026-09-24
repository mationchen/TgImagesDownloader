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
  summarizeRun,
  type DownloadState,
  type RunSummary,
  initDownloadState,
} from './downloadReducer';
import {
  createQueue,
  type QueueController,
  type TaskOutcome,
  type TaskRunner,
} from './downloadQueue';
import type { TelegraphArticle, TelegraphImage } from '../types/telegraph';
import { downloadImageToMediaStore } from '../services/imageDownloader';
import { recordHistoryFromState } from '../services/historyService';
import {
  ensureNotificationPermission,
  isNotifierSupported,
  notifyDownloadFinished,
  notifyDownloadProgress,
  notifyDownloadStart,
  notifyDownloadStop,
  subscribeDownloadKeepAlive,
} from '../services/downloadNotifier';
import { APP_CONFIG } from '../constants/config';
import {
  computeRelativePath,
  computeSubfolder,
  getSettingsSync,
} from '../services/settingsService';
import { PermissionsAndroid, Platform } from 'react-native';

interface DownloadContextValue {
  state: DownloadState;
  summary: ReturnType<typeof computeSummary>;
  start: (article: TelegraphArticle, images: TelegraphImage[]) => void;
  /**
   * Programmatic batch-mode entry. Sets state, runs the queue, and resolves
   * with the per-image {@link RunSummary} when the queue's drain loop exits on
   * its own (all tasks finished or skipped). Rejects on external
   * `signal.abort` so a batch caller can wire its "取消全部" button to a
   * single AbortController.
   */
  runDownload: (
    article: TelegraphArticle,
    opts?: {
      signal?: AbortSignal;
      onProgress?: (cur: number, total: number) => void;
    },
  ) => Promise<RunSummary>;
  /**
   * Batch-session guard for the url.txt flow. While a session is active the
   * foreground service stays up across articles (no 5s auto-stop after each
   * article finishes), so the whole batch keeps its background protection;
   * Android 12+ forbids restarting a foreground service from the background,
   * so the session must be opened while the app is still visible.
   * Android-only; a no-op on iOS.
   */
  beginBatchSession: (title: string) => void;
  /**
   * End the batch session and release the foreground service. Pass the
   * aggregate image counts when the batch completed normally so a completion
   * notification is shown before the service is dismissed; omit it (e.g. on
   * cancel) to stop immediately.
   */
  endBatchSession: (summary?: {
    success: number;
    failed: number;
    skipped: number;
  }) => void;
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
    article: { url: '', title: '', images: [], parsedAt: 0 },
    subfolder: 'untitled',
    subfolderLeaf: '',
    batchToken: '',
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
    return async (image, subfolder, ctx, meta) => {
      console.log(
        `[DL] runTask start id=${image.id} index=${
          image.index
        } subfolder=${subfolder} articleTitle=${meta?.articleTitle ?? ''}`,
      );
      // Translate DownloadOutcome -> TaskOutcome so the queue doesn't have
      // to know about MediaStore / blob-util specifics.
      const settings = getSettingsSync();
      const r = await downloadImageToMediaStore(
        image,
        subfolder,
        {
          signal: ctx.signal,
          onProgress: (downloaded, total) => {
            console.log(`[DL] progress id=${image.id} ${downloaded}/${total}`);
            ctx.onProgress(downloaded, total);
          },
        },
        meta
          ? {
              articleTitle: meta.articleTitle,
              indexCounter: meta.indexCounter,
              batchToken: meta.batchToken,
              customTreeUri:
                settings.storageType === 'custom'
                  ? settings.customTreeUri
                  : undefined,
            }
          : {
              customTreeUri:
                settings.storageType === 'custom'
                  ? settings.customTreeUri
                  : undefined,
            },
      );
      console.log(
        `[DL] runTask done id=${image.id} kind=${r.kind} code=${
          (r as { code?: string }).code ?? ''
        }`,
      );
      if (ctx.signal.aborted) {
        console.log(`[DL] cancelled mid-task id=${image.id}`);
        return { kind: 'cancelled' } satisfies TaskOutcome;
      }
      if (r.kind === 'success') {
        return {
          kind: 'success',
          localPath: r.result.uri,
          bytes: r.result.bytes,
        };
      }
      if (r.kind === 'skipped') {
        return { kind: 'skipped', reason: r.reason };
      }
      return { kind: 'failed', code: r.code, message: r.message };
    };
  }, []);

  // Throttle progress notifications so we don't spam NotificationManager.
  const lastNotifyRef = useRef(0);
  const notifyStartedForRef = useRef<{ title: string; total: number } | null>(
    null,
  );
  // "Auto-stop the notification 5s after finish" timer. Declared here (not
  // next to the effect) so the batch-session callbacks can cancel it too.
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // While a url.txt batch runs, the foreground service must survive across
  // articles: a per-article auto-stop would tear it down during a parsing
  // gap, and Android 12+ refuses startForegroundService from the background.
  const batchSessionRef = useRef(false);
  const batchTitleRef = useRef('');

  const start = useCallback(
    (article: TelegraphArticle, images: TelegraphImage[]) => {
      const { kickoffQueue } = setupQueue(
        article,
        images,
        undefined,
        undefined,
      );
      kickoffQueue();
    },
    // `setupQueue` closes over `buildRunner` and `getSettingsSync` via module
    // state; since this callback is recreated only when buildRunner changes
    // (buildRunner is `useCallback([])`), the consumer side stays stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildRunner],
  );

  /**
   * Programmatic batch-mode entry. Identical to `start` but returns a
   * Promise that resolves when the queue's drain loop exits on its own
   * (all tasks finished or skipped) and rejects on external `signal.abort`.
   * Used by the batch URL-download flow so the scheduler can advance to the
   * next URL without a manual "done" tap.
   */
  const runDownload = useCallback(
    (
      article: TelegraphArticle,
      opts?: {
        signal?: AbortSignal;
        onProgress?: (cur: number, total: number) => void;
      },
    ): Promise<RunSummary> => {
      return new Promise<RunSummary>((resolve, reject) => {
        const externalSignal = opts?.signal;
        if (externalSignal?.aborted) {
          reject(new Error('aborted before start'));
          return;
        }
        const onFinished = (finalState: DownloadState) => {
          // Persist one history row per URL. This path is batch-only
          // (Home/DownloadScreen uses `start`, not `runDownload`), so the
          // batch URL flow shows up in 下载记录 just like the Home flow.
          recordHistoryFromState(finalState).catch(() => undefined);
          resolve(summarizeRun(finalState));
        };
        if (externalSignal) {
          externalSignal.addEventListener(
            'abort',
            () => {
              // cancel() aborts in-flight tasks and exits drain. The Promise
              // rejects so the batch scheduler treats this URL as "cancelled".
              queueRef.current?.cancel();
              reject(new Error('batch cancelled'));
            },
            { once: true },
          );
        }
        const total = article.images.length;
        let completed = 0;
        // The queue fires `onTaskComplete` once per task that reaches a
        // terminal state; we translate that into a live "completed / total"
        // counter so the batch screen updates in real time instead of
        // jumping at the end of the URL.
        const onTaskComplete = () => {
          completed += 1;
          opts?.onProgress?.(completed, total);
        };
        const { kickoffQueue } = setupQueue(
          article,
          article.images,
          onFinished,
          onTaskComplete,
        );
        kickoffQueue();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildRunner],
  );

  /**
   * Internal: build init state + dispatch + queue + set up cancel hooks,
   * returning a `kickoffQueue` to actually start it (kept separate so
   * `runDownload` can defer until after wiring up its `onQueueFinished`
   * observer via `setupQueue`'s third arg).
   */
  function setupQueue(
    article: TelegraphArticle,
    images: TelegraphImage[],
    onQueueFinished: ((state: DownloadState) => void) | undefined,
    onTaskComplete:
      | ((state: DownloadState, imageId: string) => void)
      | undefined,
  ): { queue: QueueController; kickoffQueue: () => void } {
    const settings = getSettingsSync();
    const relativePath = computeRelativePath(article, settings);
    // Native saver prepends its own base path, so it must only receive the
    // leaf subfolder ('' = save straight into the app base folder).
    const subfolderLeaf = computeSubfolder(article, settings);
    console.log(
      `[DL] start title="${article.title}" images=${images.length} relativePath=${relativePath} subfolderLeaf=${subfolderLeaf} storageType=${settings.storageType}`,
    );
    // Legacy Android (< Q) needs WRITE_EXTERNAL_STORAGE for File API path;
    // Q+ uses MediaStore and needs no runtime permission.
    if (Platform.OS === 'android' && Platform.Version < 29) {
      PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      ).then(granted => {
        if (!granted) {
          PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          ).then(result => {
            console.log(`[DL] WRITE_EXTERNAL_STORAGE request result=${result}`);
          });
        } else {
          console.log('[DL] WRITE_EXTERNAL_STORAGE already granted');
        }
      });
    } else {
      console.log(
        `[DL] storage permission not needed (Q+ MediaStore) SDK=${Platform.Version}`,
      );
    }
    const initState = initDownloadState(
      article,
      images,
      relativePath,
      subfolderLeaf,
    );
    dispatch({
      type: 'init',
      article,
      images,
      subfolder: relativePath,
      subfolderLeaf,
    });

    // Kick off a foreground service + progress notification (spec §20/§21).
    // Start the service even when POST_NOTIFICATIONS is denied: it is what
    // keeps the process (and the JS queue) alive in the background; the
    // notification is simply hidden on Android 13+ without the permission.
    // The permission is requested in parallel, best-effort.
    if (isNotifierSupported() && images.length > 0) {
      notifyStartedForRef.current = {
        title: article.title,
        total: images.length,
      };
      notifyDownloadStart(article.title, images.length);
      lastNotifyRef.current = Date.now();
      ensureNotificationPermission().catch(() => undefined);
    }

    // Use a synchronous queueState so drain's live/cap check sees the
    // effect of `task/started` immediately, without waiting for React to
    // flush. This fixes the "0/48 → all 48 started at once → 17 parallel
    // → all interrupted" storm seen in the logs.
    //
    // Cancel any leftover "auto-stop notification 5s after finish" timer
    // from a previous batch — otherwise stacked timers from multiple
    // completed batches race each other to stop the foreground service.
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    queueRef.current?.cancel();
    let queueState: DownloadState = initState;
    const q = createQueue({
      getState: () => queueState,
      dispatch: a => {
        queueState = downloadReducer(queueState, a);
        console.log(
          `[DL] dispatch ${a.type} id=${(a as { id?: string }).id ?? ''} rev=${
            queueState.rev
          } live=${
            Object.values(queueState.tasks).filter(
              t => t.status === 'downloading',
            ).length
          }`,
        );
        dispatch(a);
      },
      runTask: buildRunner(),
      getConcurrency: () => concurrencyRef.current,
      onQueueFinished,
      onTaskComplete,
    });
    queueRef.current = q;
    console.log(
      `[DL] queue created total=${initState.taskOrder.length} concurrency=${concurrencyRef.current}`,
    );
    const kickoffQueue = () => {
      // Keep stateRef in sync for consumers that read React state (Home badge etc.)
      // The queue's own state is synchronous; React state will catch up via dispatch.
      setTimeout(() => {
        console.log(
          `[DL] queue start queueStateLen=${queueState.taskOrder.length} stateRefLen=${stateRef.current.taskOrder.length}`,
        );
        q.start();
        console.log(`[DL] queue start called isActive=${q.isActive()}`);
      }, 16);
    };
    return { queue: q, kickoffQueue };
  }

  const pause = useCallback(() => queueRef.current?.pause(), []);
  const resume = useCallback(() => queueRef.current?.resume(), []);
  const cancel = useCallback(() => {
    queueRef.current?.cancel();
    // During a batch session the foreground service must stay up for the
    // following articles ("跳过当前" routes through cancel()); it is torn
    // down by endBatchSession() instead. Single-article flows stop here.
    if (!batchSessionRef.current) {
      notifyDownloadStop();
      notifyStartedForRef.current = null;
    }
  }, []);

  const beginBatchSession = useCallback((title: string) => {
    batchSessionRef.current = true;
    batchTitleRef.current = title;
    // A previous session's "delayed auto-stop" timer must not survive into
    // this batch — it would tear the freshly started service down ~5s in,
    // and Android 12+ then forbids restarting it from the background.
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (!isNotifierSupported()) return;
    // Start the service right now, while the app is guaranteed to be in the
    // foreground (the user just tapped 开始): Android 12+ rejects
    // startForegroundService from the background, so this is the only safe
    // moment to bring the service up for the whole batch.
    notifyStartedForRef.current = { title, total: 0 };
    notifyDownloadStart(title, 0);
    ensureNotificationPermission().catch(() => undefined);
  }, []);

  const endBatchSession = useCallback(
    (summary?: { success: number; failed: number; skipped: number }) => {
      batchSessionRef.current = false;
      batchTitleRef.current = '';
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      if (summary && isNotifierSupported() && notifyStartedForRef.current) {
        // Batch completed normally: surface the aggregate result in the
        // notification shade for a few seconds before releasing the service
        // (same pattern as the single-article completion notification) so a
        // user who stayed in another app still sees the outcome.
        notifyDownloadFinished(
          summary.success,
          summary.failed,
          summary.skipped,
        );
        notifyStartedForRef.current = null;
        stopTimerRef.current = setTimeout(() => {
          notifyDownloadStop();
          stopTimerRef.current = null;
        }, 5000);
      } else {
        // Cancelled (or nothing was ever started): release immediately.
        notifyDownloadStop();
        notifyStartedForRef.current = null;
      }
    },
    [],
  );

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
        (t): t is NonNullable<typeof t> => t != null && t.status === 'failed',
      )
      .map(t => {
        const img = stateRef.current.article.images.find(i => i.id === t.id);
        if (!img) return null;
        return { ...img, selected: true };
      })
      .filter((img): img is TelegraphImage => img != null);
    if (failedImages.length === 0) return;
    start(stateRef.current.article, failedImages);
  }, [start]);

  const summary = useMemo(() => computeSummary(state), [state]);

  // Drive the foreground notification from queue state (spec §21):
  //   - running  -> throttled progress updates
  //   - finished -> completion summary, then auto-stop after a delay
  //     (suppressed while a batch session is active: the service must live
  //     until the last URL of the batch is done)
  useEffect(() => {
    console.log(
      `[DL] notification effect finished=${summary.finished} success=${summary.success} failed=${summary.failed} skipped=${summary.skipped} downloading=${summary.downloading}`,
    );
    if (!isNotifierSupported()) return;
    if (!notifyStartedForRef.current) return;

    if (summary.finished) {
      console.log(
        `[DL] download FINISHED success=${summary.success} failed=${summary.failed} skipped=${summary.skipped} total=${summary.total}`,
      );
      if (batchSessionRef.current) {
        // Between batch articles: swap back to the generic batch
        // notification (indeterminate bar) and keep the service + wake lock
        // running until endBatchSession().
        if (batchTitleRef.current) {
          notifyStartedForRef.current = {
            title: batchTitleRef.current,
            total: 0,
          };
          notifyDownloadStart(batchTitleRef.current, 0);
        }
        return;
      }
      notifyDownloadFinished(summary.success, summary.failed, summary.skipped);
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
    const done =
      summary.success + summary.skipped + summary.failed + summary.cancelled;
    notifyDownloadProgress(done, summary.total);
  }, [summary, state.isPaused]);

  // Clean up timers on unmount.
  useEffect(
    () => () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    },
    [],
  );

  /**
   * Native keep-alive tick (Android, see DownloadForegroundService).
   *
   * Aggressive OEM power managers freeze a backgrounded app's JS thread even
   * with a foreground service + wake lock held, which stops the drain loop's
   * setTimeout pollers and makes the batch look "paused" until the app returns
   * to the foreground. The service emits an event every couple of seconds;
   * each delivery wakes the JS thread, and `nudge()` bumps state.rev so any
   * parked drain poller immediately sees it and pulls the next task.
   */
  useEffect(() => {
    if (!isNotifierSupported()) return undefined;
    return subscribeDownloadKeepAlive(() => {
      const q = queueRef.current;
      if (q?.isActive() && !stateRef.current.isPaused) {
        q.nudge();
      }
    });
  }, []);

  const value = useMemo<DownloadContextValue>(
    () => ({
      state,
      summary,
      start,
      runDownload,
      beginBatchSession,
      endBatchSession,
      pause,
      resume,
      cancel,
      retryFailed,
      setConcurrency,
      concurrency: concurrencyRef.current,
    }),
    [
      state,
      summary,
      start,
      runDownload,
      beginBatchSession,
      endBatchSession,
      pause,
      resume,
      cancel,
      retryFailed,
      setConcurrency,
    ],
  );

  return (
    <DownloadContext.Provider value={value}>
      {children}
    </DownloadContext.Provider>
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
