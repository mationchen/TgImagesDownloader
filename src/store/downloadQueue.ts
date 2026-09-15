import { delayMs } from '../utils/retry';
import { computeSummary } from './downloadReducer';
import type { DownloadAction, DownloadState } from './downloadReducer';
import type { TelegraphImage } from '../types/telegraph';

/**
 * Reason a single task invocation ended. The queue uses this to decide
 * whether the slot should be requeued, marked as retried-within-the-same-task,
 * or finalized.
 */
export type TaskOutcome =
  | { kind: 'success'; localPath: string; bytes: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'cancelled' };

/**
 * A pluggable function that performs the actual work for one task.
 * Implementations are expected to:
 *   - Resolve with a TaskOutcome when the work is done.
 *   - Honour `signal`: when `signal.aborted` flips to true mid-work, they
 *     should stop work promptly and resolve with `{kind: 'cancelled'}`.
 *   - Call `onProgress(bytes, total)` periodically so the UI can render a bar.
 */
export type TaskRunner = (
  image: TelegraphImage,
  /** Leaf subfolder handed to the native saver ('' = app base folder). */
  subfolder: string,
  ctx: TaskRunnerContext,
  meta?: { articleTitle: string; indexCounter?: number; batchToken?: string },
) => Promise<TaskOutcome>;

export interface TaskRunnerContext {
  /** If true, the task must stop as soon as practical and resolve cancelled. */
  signal: AbortSignal;
  /** 1-based attempt counter for this task (1 = first try). */
  attempt: number;
  /** Reports download progress; implementations may call 0+ times. */
  onProgress: (downloadedBytes: number, totalBytes: number) => void;
}

export interface CreateQueueOptions {
  /** Read fresh state to know what's pending / paused / running. */
  getState: () => DownloadState;
  /** Push state changes; the reducer is the source of truth for tasks. */
  dispatch: (action: DownloadAction) => void;
  /** Per-image runner; typically wraps the native downloader. */
  runTask: TaskRunner;
  /** Effective concurrency (read each tick so settings can change live). */
  getConcurrency: () => number;
  /** Per-task max retry attempts (default 2). */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries (default 500ms). */
  retryBaseMs?: number;
  /** Cap for exponential backoff (default 15s). */
  retryCapMs?: number;
  /** Optional external signal — when fired, the whole queue cancels. */
  externalSignal?: AbortSignal;
  /**
   * Fired exactly once when the drain loop exits on its own (all tasks
   * drained, `live === 0` and nothing more to start). NOT fired by
   * `cancel()`; cancel uses `drainAbort` to short-circuit waiters but does
   * not invoke this callback. Useful for batch-mode callers that need to
   * know when a per-article run completed naturally. Receives the final
   * state so the caller can inspect the per-image outcomes.
   */
  onQueueFinished?: (state: DownloadState) => void;
}

export interface QueueController {
  start: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  /** True iff a `start()` was called and the loop hasn't drained yet. */
  isActive: () => boolean;
}

/**
 * Concurrency-limited, pause-aware download queue.
 *
 * Design notes:
 *   - One timer/awaiter loop per queue; it pulls pending tasks from
 *     state.taskOrder and only starts up to `concurrency` in parallel.
 *   - State (per-task status, retry counts, progress) lives in the reducer,
 *     NOT in this module — so React can subscribe and re-render naturally.
 *   - Cancellation: each in-flight task gets its own AbortController; the
 *     queue's own controller cascades when `cancel()` is called or when the
 *     external signal fires.
 *   - Retry: handled INSIDE runTask via ctx.attempt — the queue simply
 *     re-invokes runTask with an incremented attempt on transient errors.
 */
export function createQueue(opts: CreateQueueOptions): QueueController {
  const {
    getState,
    dispatch,
    runTask,
    getConcurrency,
    maxRetries = 2,
    retryBaseMs = 500,
    retryCapMs = 15_000,
    externalSignal,
    onQueueFinished,
  } = opts;

  // Controllers for in-flight tasks, keyed by image id. Used to abort them
  // when the queue is cancelled.
  const inFlight = new Map<string, AbortController>();

  // Per-queue cancellation token. All `waitForRev` pollers inside `drain()`
  // subscribe to this so that `cancel()` immediately stops their setTimeout
  // chain instead of leaving orphaned 16ms pollers to leak CPU/memory.
  const drainAbort = new AbortController();

  let active = false;
  let drainPromise: Promise<void> | null = null;

  function start(): void {
    if (active) return;
    active = true;
    dispatch({ type: 'queue/resumed' });
    drainPromise = drain();
  }

  function pause(): void {
    if (!active) return;
    dispatch({ type: 'queue/paused' });
  }

  function resume(): void {
    if (!active) return;
    dispatch({ type: 'queue/resumed' });
    if (!drainPromise) {
      drainPromise = drain();
    }
  }

  function cancel(): void {
    // Note: do NOT early-return on `!active` — once a queue has been
    // cancelled, every pending `waitForRev` Promise must still resolve so
    // its setTimeout chain is cleared. `drainAbort.abort()` is idempotent.
    if (drainAbort.signal.aborted) {
      // Already cancelled; nothing more to do.
      return;
    }
    drainAbort.abort();
    active = false;
    // Abort all in-flight tasks; pending ones won't be picked up because
    // active flips off and the drain loop exits.
    for (const [, ctrl] of inFlight) {
      ctrl.abort();
    }
    inFlight.clear();
    dispatch({ type: 'queue/stopped' });
    // Mark any remaining pending as cancelled.
    const s = getState();
    for (const id of s.taskOrder) {
      const t = s.tasks[id];
      if (t && (t.status === 'pending' || t.status === 'downloading')) {
        dispatch({ type: 'task/cancelled', id });
      }
    }
  }

  function isActive(): boolean {
    return active;
  }

  async function drain(): Promise<void> {
    console.log(
      `[DL] drain start active=${active} cap=${getConcurrency()} pending=${countPending(
        getState(),
      )} live=${countActive(getState())}`,
    );
    try {
      while (active) {
        const state = getState();
        if (state.isPaused) {
          console.log('[DL] drain paused');
          // Wait for the resume action to bump state.rev.
          await waitForRev(state.rev, getState, drainAbort.signal);
          continue;
        }
        const cap = getConcurrency();
        const live = countActive(state);
        if (live >= cap) {
          console.log(`[DL] drain at cap live=${live} cap=${cap}`);
          // Wait for any task to finish (rev bump) before pulling more.
          await waitForRev(state.rev, getState, drainAbort.signal);
          continue;
        }
        const next = pickNextPending(state, inFlight.keys());
        console.log(
          `[DL] drain pick next=${
            next?.imageId ?? 'none'
          } live=${live} cap=${cap} total=${state.taskOrder.length}`,
        );
        if (!next) {
          // No more work; check if anything is still in flight.
          if (live === 0) {
            console.log('[DL] drain no more work, stopping');
            active = false;
            dispatch({ type: 'queue/stopped' });
            onQueueFinished?.(getState());
            return;
          }
          await waitForRev(state.rev, getState, drainAbort.signal);
          continue;
        }
        // Dispatch started and kick off runTask. We do NOT await here — we
        // want up-to-concurrency tasks in flight at once.
        const ctrl = new AbortController();
        if (externalSignal) {
          if (externalSignal.aborted) {
            ctrl.abort();
          } else {
            externalSignal.addEventListener('abort', () => ctrl.abort(), {
              once: true,
            });
          }
        }
        inFlight.set(next.imageId, ctrl);
        console.log(`[DL] dispatch task/started id=${next.imageId}`);
        dispatch({
          type: 'task/started',
          id: next.imageId,
          startedAt: Date.now(),
        });
        runOne(next.imageId, ctrl).finally(() => {
          inFlight.delete(next.imageId);
          console.log(
            `[DL] inFlight deleted id=${next.imageId} remaining=${inFlight.size}`,
          );
        });
        // Yield to the event loop so React can flush the dispatch.
        await microtask();
      }
    } finally {
      drainPromise = null;
      console.log('[DL] drain end');
    }
  }

  async function runOne(id: string, ctrl: AbortController): Promise<void> {
    let attempt = 1;
    while (true) {
      if (ctrl.signal.aborted) {
        console.log(`[DL] runOne aborted before start id=${id}`);
        // Task was cancelled between scheduling and execution.
        return;
      }
      const state = getState();
      // Native saver expects the *leaf* subfolder, not the full RELATIVE_PATH.
      const subfolder = state.subfolderLeaf;
      const image = state.article.images.find(i => i.id === id);
      const articleTitle = state.article.title;
      const indexCounter = state.taskOrder.indexOf(id) + 1;
      if (!image) {
        console.log(`[DL] runOne no image id=${id}`);
        dispatch({
          type: 'task/failed',
          id,
          errorCode: 'ERR_NO_TASK',
          errorMessage: 'image disappeared from article',
        });
        return;
      }
      console.log(`[DL] runOne attempt=${attempt} id=${id} url=${image.url}`);
      const ctx: TaskRunnerContext = {
        signal: ctrl.signal,
        attempt,
        onProgress: (downloaded, total) => {
          console.log(`[DL] task/progress id=${id} ${downloaded}/${total}`);
          dispatch({
            type: 'task/progress',
            id,
            downloadedBytes: downloaded,
            totalBytes: total,
          });
        },
      };
      let outcome: TaskOutcome;
      try {
        outcome = await runTask(image, subfolder, ctx, {
          articleTitle,
          indexCounter,
          batchToken: state.batchToken,
        });
      } catch (err) {
        console.log(`[DL] runTask threw id=${id} err=${String(err)}`);
        // Defensive: runTask should never throw, but if it does, treat as
        // a hard failure so the slot can move on.
        outcome = {
          kind: 'failed',
          code: 'ERR_UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      console.log(`[DL] runOne outcome id=${id} kind=${outcome.kind}`);
      if (outcome.kind === 'cancelled') {
        dispatch({ type: 'task/cancelled', id });
        return;
      }
      if (outcome.kind === 'success') {
        dispatch({ type: 'task/success', id, localPath: outcome.localPath });
        return;
      }
      if (outcome.kind === 'skipped') {
        dispatch({ type: 'task/skipped', id, reason: outcome.reason });
        return;
      }
      // failed — maybe retry
      const isRetryable = isRetryableCode(outcome.code);
      console.log(
        `[DL] failed id=${id} code=${outcome.code} retryable=${isRetryable} attempt=${attempt}`,
      );
      if (!isRetryable || attempt > maxRetries) {
        dispatch({
          type: 'task/failed',
          id,
          errorCode: outcome.code,
          errorMessage: outcome.message,
        });
        return;
      }
      attempt += 1;
      const wait = delayMs(attempt - 1, retryBaseMs, retryCapMs);
      dispatch({
        type: 'task/retrying',
        id,
        attempt,
        nextDelayMs: wait,
      });
      // Sleep with abort awareness so cancel() is responsive.
      try {
        await abortableSleep(wait, ctrl.signal);
      } catch {
        // aborted during sleep -> cancelled.
        const s = getState();
        const t = s.tasks[id];
        if (t && t.status !== 'cancelled') {
          dispatch({ type: 'task/cancelled', id });
        }
        return;
      }
    }
  }

  return { start, pause, resume, cancel, isActive };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function countActive(state: DownloadState): number {
  let n = 0;
  for (const id of state.taskOrder) {
    if (state.tasks[id]?.status === 'downloading') n += 1;
  }
  return n;
}

function countPending(state: DownloadState): number {
  let n = 0;
  for (const id of state.taskOrder) {
    if (state.tasks[id]?.status === 'pending') n += 1;
  }
  return n;
}

function pickNextPending(
  state: DownloadState,
  inFlightKeys: Iterable<string>,
): { imageId: string } | null {
  let inFlight: Set<string> | null = null;
  for (const id of state.taskOrder) {
    const t = state.tasks[id];
    if (!t || t.status !== 'pending') continue;
    // Skip tasks currently owned by an in-flight runOne (e.g. sitting in
    // their retry-backoff sleep). Without this guard, a task that just
    // dispatched `task/retrying` would look pending again and the drain loop
    // would pick it up a second time, double-firing the runner.
    if (!inFlight) {
      inFlight =
        inFlightKeys instanceof Set ? inFlightKeys : new Set(inFlightKeys);
    }
    if (inFlight.has(id)) continue;
    return { imageId: id };
  }
  return null;
}

/**
 * Resolve once `getState().rev` differs from `current`. Used by the drain
 * loop to park while paused / while at concurrency cap.
 */
function waitForRev(
  current: number,
  getState: () => DownloadState,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const tick = () => {
      if (signal.aborted) {
        onAbort();
        return;
      }
      const s = getState();
      if (s.rev !== current) {
        onAbort();
        return;
      }
      // Poll lightly; the rev bumps on every reducer dispatch so the gap is
      // usually < 16ms in practice.
      timer = setTimeout(tick, 16);
    };
    tick();
  });
}

function microtask(): Promise<void> {
  return new Promise(resolve => {
    const q = (globalThis as { queueMicrotask?: (cb: () => void) => void })
      .queueMicrotask;
    if (typeof q === 'function') {
      q(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Decide whether a failed task is worth retrying based on the error code we
 * surface from imageDownloader. Spec §28: 429 / 5xx retry, 404 no / 1 retry,
 * 403 don't retry. We mirror the same logic at the queue layer so it works
 * regardless of who produced the outcome.
 */
function isRetryableCode(code: string): boolean {
  if (/^HTTP_(5\d\d|429|408)$/.test(code)) return true;
  if (/^HTTP_404$/.test(code)) return false;
  if (/^HTTP_403$/.test(code)) return false;
  // Anti-hotlink / blocked-host protection is deterministic — retrying won't help.
  if (/^ERR_HOTLINK_BLOCKED$/.test(code)) return false;
  if (/^ERR_BLOCKED_HOST/.test(code)) return false;
  if (/^ERR_DOWNLOAD$/.test(code)) return true;
  if (/^ERR_IO$/.test(code)) return true;
  if (/^ERR_NATIVE$/.test(code)) return false;
  if (/^ERR_EMPTY$/.test(code)) return false;
  if (/^ERR_UNSAFE_URL$/.test(code)) return false;
  if (/^ERR_INVALID/.test(code)) return false;
  return false;
}

export { computeSummary };
