/**
 * 让「保存到相册」的顺序与页码一致，而下载仍可并发。
 *
 * 背景：普通图集是 8 线程并发下载，谁先下完谁先写进 MediaStore，于是系统相册
 * （按 `DATE_ADDED` 倒序）里相邻几张可能互换。App 内的宫格和文件名一直是按
 * 页码排的，只有相册会乱。
 *
 * 做法：并发下完的图片先不急着入库，排队等自己的「轮次」；
 * 轮次按**页码从大到小**（第 N 页先写、第 1 页最后写），这样相册倒序打开时
 * 第 1 页排在最前面。
 *
 * 关键约束：
 *   - 任务失败 / 取消 / 跳过时，调用方必须 `done(position)`，否则后面的图会
 *     一直等下去（这里不做超时，避免顺序又变得不可控）；
 *   - 取消整批时调用 `cancel()`，所有等待者立即以 reject 结束。
 */

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export interface SaveOrderGate {
  /**
   * 等到「轮到自己入库」。`position` 是 1 基页码（第 N 页 = N）。
   * 已经轮过 / 不在集合里 → 立即 resolve；被取消 → reject。
   */
  turn(position: number, signal?: AbortSignal): Promise<void>;
  /**
   * 某个位置处理完了（入库成功、跳过、失败或取消都算），放行下一个。
   * 重复调用无害。
   */
  done(position: number): void;
  /** 整批取消：所有等待者立即 reject。 */
  cancel(): void;
}

export function createSaveOrderGate(positions: number[]): SaveOrderGate {
  const remaining = new Set(positions.filter(p => Number.isFinite(p) && p > 0));
  const waiters = new Map<number, Waiter[]>();
  let next = maxOf(remaining);
  let cancelled = false;

  const takeWaiters = (position: number): Waiter[] => {
    const list = waiters.get(position) ?? [];
    waiters.delete(position);
    return list;
  };

  const openNext = () => {
    if (cancelled) return;
    if (remaining.size === 0) return;
    next = maxOf(remaining);
    for (const w of takeWaiters(next)) {
      w.cleanup();
      w.resolve();
    }
  };

  return {
    turn(position, signal) {
      if (cancelled) {
        return Promise.reject(new Error('save order gate cancelled'));
      }
      // 不在本轮集合里 / 已经轮到过 → 不必等待。
      if (!remaining.has(position) || position >= next) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          cleanup: () => undefined,
        };
        const onAbort = () => {
          removeWaiter(position, waiter);
          reject(new Error('save order gate aborted'));
        };
        if (signal) {
          if (signal.aborted) {
            reject(new Error('save order gate aborted'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        const list = waiters.get(position) ?? [];
        list.push(waiter);
        waiters.set(position, list);
      });
    },

    done(position) {
      if (!remaining.delete(position)) return;
      if (cancelled) return;
      // 只有「当前轮次」完成才需要放行下一张；其它位置先做完只是少一个等待项。
      if (position === next) openNext();
    },

    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const list of waiters.values()) {
        for (const w of list) {
          w.cleanup();
          w.reject(new Error('save order gate cancelled'));
        }
      }
      waiters.clear();
      remaining.clear();
    },
  };

  function removeWaiter(position: number, waiter: Waiter) {
    const list = waiters.get(position);
    if (!list) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) waiters.delete(position);
  }

  function maxOf(set: Set<number>): number {
    let max = 0;
    for (const p of set) if (p > max) max = p;
    return max;
  }
}
