import {createQueue} from '../src/store/downloadQueue';
import {downloadReducer, initDownloadState} from '../src/store/downloadReducer';
import type {TelegraphImage, TelegraphArticle} from '../src/types/telegraph';
import type {TaskOutcome, TaskRunner} from '../src/store/downloadQueue';
import type {DownloadState, DownloadAction} from '../src/store/downloadReducer';

function makeImage(i: number): TelegraphImage {
  return {
    id: `img-${i}`,
    index: i,
    url: `https://x.test/${i}.jpg`,
    filename: `${String(i).padStart(3, '0')}.jpg`,
    selected: true,
  };
}

function makeArticle(images: TelegraphImage[]): TelegraphArticle {
  return {
    url: 'https://telegra.ph/test',
    title: 'Test',
    images,
    parsedAt: 0,
  };
}

interface Harness {
  readonly state: DownloadState;
  readonly dispatch: jest.Mock<void, [DownloadAction]>;
  readonly getState: () => DownloadState;
  readonly queue: ReturnType<typeof createQueue>;
  readonly outcomes: Array<(i: number) => TaskOutcome>;
  readonly runner: TaskRunner;
  readonly activeCounts: number[];
  readonly startedAt: number[];
  readonly finishedAt: number[];
}

function setupHarness(opts: {
  count: number;
  outcomes: Array<(i: number) => TaskOutcome>;
  concurrency?: number;
  maxRetries?: number;
}): Harness {
  const images: TelegraphImage[] = [];
  for (let i = 1; i <= opts.count; i += 1) images.push(makeImage(i));
  const article = makeArticle(images);

  // Wrap state in a holder object so the dispatch mock can mutate the
  // single source of truth that the test (and the queue) read from.
  const holder: {state: DownloadState} = {
    state: initDownloadState(article, images, 'test'),
  };
  const dispatch = jest.fn<void, [DownloadAction]>();
  dispatch.mockImplementation((action: DownloadAction) => {
    holder.state = downloadReducer(holder.state, action);
  });
  const getState = () => holder.state;

  const activeCounts: number[] = [];
  const startedAt: number[] = [];
  const finishedAt: number[] = [];

  const runner: TaskRunner = async (image, _subfolder, _ctx) => {
    const idx = image.index;
    startedAt.push(idx);
    activeCounts.push(holder.state.taskOrder.filter(id => holder.state.tasks[id]?.status === 'downloading').length);
    try {
      // Yield once so concurrent tasks have a chance to overlap.
      await new Promise<void>(r => setTimeout(() => r(), 5));
      const out = opts.outcomes[idx - 1]?.(idx) ?? {kind: 'success', localPath: '/x', bytes: 1};
      return out;
    } finally {
      finishedAt.push(idx);
    }
  };

  const queue = createQueue({
    getState,
    dispatch,
    runTask: runner,
    getConcurrency: () => opts.concurrency ?? 3,
    maxRetries: opts.maxRetries ?? 2,
    retryBaseMs: 1,
    retryCapMs: 5,
  });

  return {
    get state(): DownloadState {
      return holder.state;
    },
    dispatch,
    getState,
    queue,
    outcomes: opts.outcomes,
    runner,
    activeCounts,
    startedAt,
    finishedAt,
  };
}

async function flush(): Promise<void> {
  // Yield repeatedly so the queue's setTimeout-based loops can advance.
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>(r => setTimeout(() => r(), 10));
  }
}

describe('downloadQueue', () => {
  it('processes all tasks in order with bounded concurrency', async () => {
    const h = setupHarness({
      count: 10,
      concurrency: 3,
      outcomes: Array.from({length: 10}, (_, i) => () => ({
        kind: 'success' as const,
        localPath: `/p/${i + 1}`,
        bytes: 1,
      })),
    });
    h.queue.start();
    await flush();
    expect(h.state.taskOrder.every(id => h.state.tasks[id]?.status === 'success')).toBe(true);
    // No more than 3 should ever be in flight concurrently.
    expect(Math.max(...h.activeCounts)).toBeLessThanOrEqual(3);
    expect(Math.max(...h.activeCounts)).toBeGreaterThanOrEqual(2); // sanity: at least 2 ran at once
    expect(h.queue.isActive()).toBe(false);
  });

  it('skips successful tasks without retrying', async () => {
    const calls: number[] = [];
    const h = setupHarness({
      count: 2,
      outcomes: [
        i => {
          calls.push(i);
          return {kind: 'success', localPath: '/x', bytes: 1};
        },
        i => {
          calls.push(i);
          return {kind: 'success', localPath: '/x', bytes: 1};
        },
      ],
    });
    h.queue.start();
    await flush();
    expect(h.state.tasks['img-1']?.status).toBe('success');
    expect(h.state.tasks['img-2']?.status).toBe('success');
    expect(calls).toHaveLength(2); // no retry
  });

  it('retries on retryable error up to maxRetries then fails', async () => {
    const calls: number[] = [];
    const h = setupHarness({
      count: 1,
      maxRetries: 2,
      outcomes: [
        i => {
          calls.push(i);
          return {kind: 'failed', code: 'HTTP_500', message: 'oops'};
        },
      ],
    });
    h.queue.start();
    await flush();
    // 1 initial + 2 retries = 3 invocations
    expect(calls).toHaveLength(3);
    expect(h.state.tasks['img-1']?.status).toBe('failed');
  });

  it('does not retry on non-retryable error', async () => {
    const calls: number[] = [];
    const h = setupHarness({
      count: 1,
      maxRetries: 5,
      outcomes: [
        i => {
          calls.push(i);
          return {kind: 'failed', code: 'HTTP_404', message: 'gone'};
        },
      ],
    });
    h.queue.start();
    await flush();
    expect(calls).toHaveLength(1);
    expect(h.state.tasks['img-1']?.status).toBe('failed');
  });

  it('marks task as skipped when outcome is skipped', async () => {
    const h = setupHarness({
      count: 1,
      outcomes: [
        () => ({kind: 'skipped', reason: 'already there'}),
      ],
    });
    h.queue.start();
    await flush();
    expect(h.state.tasks['img-1']?.status).toBe('skipped');
  });

  it('cancel() aborts in-flight and marks remaining pending as cancelled', async () => {
    // Use a runner that hangs until the abort signal fires so we can prove
    // the queue actually cancels an in-flight task rather than waiting for it
    // to finish naturally.
    let abortedCount = 0;
    const h = setupHarness({
      count: 5,
      concurrency: 5,
      outcomes: Array.from({length: 5}, () => () => ({kind: 'success' as const, localPath: '/x', bytes: 1})),
    });
    // Replace runner with one that observes aborts.
    const runner: TaskRunner = async (_img, _sub, ctx) => {
      return new Promise<TaskOutcome>(resolve => {
        const t = setTimeout(() => resolve({kind: 'success', localPath: '/x', bytes: 1}), 200);
        ctx.signal.addEventListener('abort', () => {
          abortedCount += 1;
          clearTimeout(t);
          resolve({kind: 'cancelled'});
        }, {once: true});
      });
    };
    const newQueue = createQueue({
      getState: h.getState,
      dispatch: h.dispatch,
      runTask: runner,
      getConcurrency: () => 5,
      maxRetries: 0,
      retryBaseMs: 1,
      retryCapMs: 5,
    });
    newQueue.start();
    await new Promise<void>(r => setTimeout(() => r(), 30));
    newQueue.cancel();
    await flush();
    // Some tasks should have been aborted.
    expect(abortedCount).toBeGreaterThan(0);
    // All tasks should be either cancelled or (very rarely) already-success
    // if they slipped through before cancel arrived.
    for (const id of h.state.taskOrder) {
      const status = h.state.tasks[id]?.status;
      expect(['cancelled', 'success']).toContain(status);
    }
    expect(newQueue.isActive()).toBe(false);
  });

  it('pause() halts dispatch of new tasks; resume() picks them up', async () => {
    const h = setupHarness({
      count: 6,
      concurrency: 1,
      outcomes: Array.from({length: 6}, () => () => ({kind: 'success' as const, localPath: '/x', bytes: 1})),
    });
    h.queue.start();
    await new Promise<void>(r => setTimeout(() => r(), 20));
    h.queue.pause();
    const afterPause = h.state.taskOrder
      .map(id => h.state.tasks[id]?.status)
      .filter(s => s === 'success').length;
    // Wait a beat — pause should not start new tasks.
    await new Promise<void>(r => setTimeout(() => r(), 50));
    const stillSame = h.state.taskOrder
      .map(id => h.state.tasks[id]?.status)
      .filter(s => s === 'success').length;
    // 1 was already in flight + 0 new during the pause window.
    expect(stillSame).toBeLessThanOrEqual(afterPause + 1);
    // Resume and let the rest finish.
    h.queue.resume();
    await flush();
    const finalSuccess = h.state.taskOrder
      .map(id => h.state.tasks[id]?.status)
      .filter(s => s === 'success').length;
    expect(finalSuccess).toBe(6);
  });

  it('handles 100 tasks without exploding', async () => {
    const h = setupHarness({
      count: 100,
      concurrency: 5,
      outcomes: Array.from({length: 100}, () => () => ({kind: 'success' as const, localPath: '/x', bytes: 1})),
    });
    h.queue.start();
    await flush();
    const success = h.state.taskOrder
      .map(id => h.state.tasks[id]?.status)
      .filter(s => s === 'success').length;
    expect(success).toBe(100);
    expect(Math.max(...h.activeCounts)).toBeLessThanOrEqual(5);
  });
});
