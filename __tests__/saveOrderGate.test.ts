import { createSaveOrderGate } from '../src/services/saveOrderGate';

describe('saveOrderGate', () => {
  it('按页码从大到小放行（第 N 页先入库、第 1 页最后）', async () => {
    const gate = createSaveOrderGate([1, 2, 3]);
    const order: number[] = [];

    const run = async (position: number) => {
      await gate.turn(position);
      order.push(position);
      gate.done(position);
    };

    // 并发启动：3 立即通过，1/2 先等着。
    await Promise.all([run(1), run(2), run(3)]).then(() => undefined);

    expect(order).toStrictEqual([3, 2, 1]);
  });

  it('某个位置跳过/失败时也能继续放行（不卡死）', async () => {
    const gate = createSaveOrderGate([1, 2, 3]);
    const order: number[] = [];

    // 第 3 页直接失败（没有入库）→ done(3) 后轮到 2。
    const p2 = gate.turn(2).then(() => {
      order.push(2);
      gate.done(2);
    });
    const p1 = gate.turn(1).then(() => {
      order.push(1);
      gate.done(1);
    });
    gate.done(3);

    await Promise.all([p2, p1]);
    expect(order).toStrictEqual([2, 1]);
  });

  it('取消时所有等待者立即结束', async () => {
    const gate = createSaveOrderGate([1, 2]);
    const waiting = gate.turn(1); // 2 还没 done，1 在等
    gate.cancel();
    await expect(waiting).rejects.toThrow(/cancelled/);
  });

  it('已经轮到过的位置再取轮次会立即通过', async () => {
    const gate = createSaveOrderGate([1, 2]);
    gate.done(2);
    await expect(gate.turn(2)).resolves.toBeUndefined();
  });
});
