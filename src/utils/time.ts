/**
 * 时间展示工具。
 *
 * 数据库里一律存 UTC 毫秒（AGENTS.md §6），**展示前**必须按用户手机所在时区
 * 转换 —— `Date` 的 getHours()/getDate() 等方法本身就是本地时区，所以这里直接
 * 用它们，不要手动加减时区偏移。
 */

/** 本地时间 `HH:mm`（下载记录列表用）。 */
export function formatLocalTime(utcMs: number): string {
  const d = new Date(utcMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** 本地日期时间 `yyyy-MM-dd HH:mm`（回收站等需要完整时间的场景）。 */
export function formatLocalDateTime(utcMs: number): string {
  const d = new Date(utcMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}
