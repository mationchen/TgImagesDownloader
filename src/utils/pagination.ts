/**
 * 下载记录列表的分页数学（纯函数，便于单测）。
 *
 * 列表按「页」展示：一页 `pageSize` 条，页码区间显示为
 * `offset+1` … `offset+已加载条数`。翻页时必须落在整页边界上，
 * 否则会出现 `881-889` 之后「上一页」变成 `781-800` 这种对不上的区间。
 */

/** 最后一页的起始偏移（按页大小对齐；`total` 为 0 时返回 0）。 */
export function lastPageOffset(total: number, pageSize: number): number {
  if (!(total > 0) || !(pageSize > 0)) return 0;
  return Math.floor((total - 1) / pageSize) * pageSize;
}

/**
 * 把请求的偏移夹到合法范围内。
 * 越界（记录被删除 / 筛选后总数变少）时回落到最后一个整页的起点，
 * 而不是用 `floor(total / batch)` 之类的半页偏移。
 */
export function clampPageOffset(
  offset: number,
  total: number,
  pageSize: number,
): number {
  if (!(total > 0)) return 0;
  const safe = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return safe >= total ? lastPageOffset(total, pageSize) : safe;
}

/**
 * 是否存在下一页：下一页的**起点**必须还落在总数之内。
 *
 * 例：total=889、pageSize=100 时，offset=800（显示 801-889）已经没有
 * 下一页（下一页起点 900 > 889），必须禁用按钮；否则会点出 `881-889`。
 */
export function hasNextPage(
  offset: number,
  total: number,
  pageSize: number,
): boolean {
  if (!(total > 0) || !(pageSize > 0)) return false;
  const safe = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return safe + pageSize < total;
}

/**
 * 按「分页张数」估算一个图集应有的图片数量区间（解析完整性检查用）。
 *
 * 站点通常每页固定 `perPage` 张，只有最后一页可能不满，所以：
 *   下限 = perPage × (pages - 1) + 1，上限 = perPage × pages
 * 实测张数低于下限 → 很可能有页没抓到（网络抖动 / 被拦截），应提示用户重试。
 */
export function expectedImageCount(
  perPage: number,
  pages: number,
): { min: number; max: number } {
  const size = Math.max(1, Math.floor(perPage));
  const count = Math.max(1, Math.floor(pages));
  if (count === 1) return { min: size, max: size };
  return { min: size * (count - 1) + 1, max: size * count };
}
