/**
 * 「最后查看的下载记录」：详情页退出时写入，下载记录列表回到前台时消费。
 *
 * 用户可能在详情页左右滑了几十条，回到列表时应该直接停在那一条，
 * 而不是被甩回顶部让他重新翻找。
 *
 * 用模块级变量而不是路由参数：这是一次性的「召回提示」，不需要留在
 * 导航状态里，也不会在返回栈里留下痕迹。
 */
let pendingId: number | null = null;

/** 记下用户在详情页最后停留的那条记录。 */
export function markLastViewedHistory(id: number): void {
  if (!Number.isFinite(id)) return;
  pendingId = id;
}

/** 取出并清空「最后查看」的记录 id（没有则返回 null）。 */
export function consumeLastViewedHistory(): number | null {
  const id = pendingId;
  pendingId = null;
  return id;
}
