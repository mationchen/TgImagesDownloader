/**
 * Helpers for turning user input into SQLite `LIKE` patterns.
 *
 * SQLite treats `%` and `_` in a pattern as wildcards and uses `\` as the
 * escape character when the query says `ESCAPE '\'`. User input must therefore
 * be escaped before it is wrapped in `%…%`, otherwise searching for `100%` or
 * `a_b` matches far more rows than intended (or nothing at all).
 *
 * 下载记录的标题搜索以前漏了 `ESCAPE` 子句：`%` / `_` 被当成通配符，
 * 输入里带这两个字符时结果就是空的。这里统一处理，查询处补上 ESCAPE。
 */

/** Escape `\`, `%` and `_` so the value matches literally inside a LIKE. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

/**
 * Pattern for a case-insensitive "contains" match: `%<escaped>%`.
 * Leading/trailing whitespace is trimmed (IMM composition often leaves a
 * trailing space); an all-whitespace input yields an empty string so callers
 * can treat it as "no filter".
 */
export function likeContainsPattern(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return `%${escapeLikePattern(trimmed)}%`;
}

/**
 * JSON fragment used to find one tag inside the `tags` column (a JSON array of
 * strings, e.g. `["a","b"]`). Matching the quoted value avoids `cats` matching
 * `catsuit`.
 */
export function tagJsonFragment(tag: string): string {
  return `"${tag.replace(/[\\"]/g, m => `\\${m}`)}"`;
}
