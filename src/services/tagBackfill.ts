/**
 * 给**已有**下载记录补全标签。
 *
 * 新下载的标签在解析阶段就顺手抓了（`services/tags.ts`），这个模块只处理
 * v7 之前的老记录：它们 `tags = '[]'`，但大多有原始网址，可以按网址回抓。
 *
 * 实测约束（2026-11）：
 *   - 同一站点**并发会被限流**（everia 5 页并发全超时，单页 1-3 秒就回），
 *     所以这里严格顺序抓，同一主机之间留间隔。
 *   - `www.1y.is` 目前整站 502（用户 308 条记录都在那儿）：单条重试 3 次仍然
 *     失败就触发**主机熔断**，不再对同一主机继续发请求，避免 308 × 3 次无谓等待。
 *   - `*.github.io` 的标签写在标题里，**不用联网**，直接用库里已有的标题解析。
 *   - `telegra.ph` 本来就没有标签，直接记「无标签」，不发请求。
 */
import { APP_CONFIG } from '../constants/config';
import {
  listHistoryNeedingTags,
  updateHistoryTags,
} from './historyService';
import { extractTags } from './tags';

export type TagBackfillProgress = {
  total: number;
  done: number;
  ok: number;
  /** 抓到了页面，但页面本来就没有标签 / 文章已删除。 */
  empty: number;
  /** 网络错误、5xx、超时。 */
  failed: number;
  /** 当前正在处理的主机，用于界面显示。 */
  currentHost: string;
  /** 已经判定不可达、被跳过的站点。 */
  unreachableHosts: string[];
};

export type TagBackfillResult = {
  total: number;
  ok: number;
  empty: number;
  failed: number;
  /** 用户中途停止。 */
  stopped: boolean;
  unreachableHosts: string[];
};

/** 单条最多尝试次数。 */
const ATTEMPTS = 3;
/** 同一主机连续请求之间的间隔。 */
const GAP_MS = 1200;
/** 站点开始变慢时，间隔最多拉长到这里。 */
const MAX_GAP_MS = 8000;
/** 同一主机连续失败多少次后判定为不可达（例如整站 502）。 */
const HOST_FAILURE_LIMIT = 5;
/** 标签只需要 HTML 的头尾，超时就当失败，别把整轮任务拖死。 */
const FETCH_TIMEOUT_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

class FetchError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  // 用 RN 自带的 fetch（和 parseArticle 同一条链路）。这里必须自己控超时：
  // everia 这类站在 OkHttp 上偶发"请求挂住"，不设上限会把整轮任务拖死。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': APP_CONFIG.telegraph.userAgent,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        // 和 parseArticle 保持一致：显式声明只接受 gzip/deflate。
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new FetchError(`HTTP ${r.status}`, r.status);
    return await r.text();
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** 标签写在标题里、不需要联网的站点。 */
function isTitleOnlyHost(host: string): boolean {
  return host.endsWith('.github.io');
}

/** 已知完全没有标签的站点（抓了也是空，省一次请求）。 */
function hasNoTagsAtAll(host: string): boolean {
  return host === 'telegra.ph';
}

/**
 * 跑一轮补全。可中断、可续跑：只处理 `tags = '[]'` 的记录，
 * 所以中途停止后再次触发就自然接着做。
 */
export async function backfillTags(opts: {
  onProgress?: (p: TagBackfillProgress) => void;
  shouldStop?: () => boolean;
  signal?: AbortSignal;
} = {}): Promise<TagBackfillResult> {
  const targets = await listHistoryNeedingTags();
  const total = targets.length;

  let done = 0;
  let ok = 0;
  let empty = 0;
  let failed = 0;
  let stopped = false;
  let currentHost = '';
  const unreachableHosts = new Set<string>();
  /** 每个主机「连续」失败计数；成功一次就清零。 */
  const consecutiveFailures = new Map<string, number>();

  const report = () =>
    opts.onProgress?.({
      total,
      done,
      ok,
      empty,
      failed,
      currentHost,
      unreachableHosts: Array.from(unreachableHosts),
    });

  report();

  let lastHost = '';
  /** 自适应间隔：连续顺利时慢慢收紧，遇到超时就逐步拉长。 */
  let gap = GAP_MS;
  for (const t of targets) {
    if (opts.shouldStop?.() || opts.signal?.aborted) {
      stopped = true;
      break;
    }
    const host = hostOf(t.url);

    if (unreachableHosts.has(host)) {
      // 站点已判定不可达：不再发请求，但也不算「搞定了」，留给下次。
      failed += 1;
      done += 1;
      report();
      continue;
    }

    if (lastHost === host) await sleep(gap);
    lastHost = host;
    currentHost = host;

    let tags: string[] = [];
    let outcome: 'ok' | 'empty' | 'failed' = 'empty';

    if (isTitleOnlyHost(host)) {
      // 静态站的井号标签在标题里，离线解析。
      tags = extractTags('', t.url, t.title);
      outcome = tags.length > 0 ? 'ok' : 'empty';
    } else if (hasNoTagsAtAll(host)) {
      outcome = 'empty';
    } else {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const startedAt = Date.now();
        try {
          const html = await fetchHtml(t.url, opts.signal);
          tags = extractTags(html, t.url, t.title);
          outcome = tags.length > 0 ? 'ok' : 'empty';
          consecutiveFailures.set(host, 0);
          console.log(
            `[tags] ${host} ok in ${Date.now() - startedAt}ms tags=${tags.length}`,
          );
          break;
        } catch (e) {
          const status = e instanceof FetchError ? e.status : 0;
          console.log(
            `[tags] ${host} attempt ${attempt} failed after ${
              Date.now() - startedAt
            }ms: ${e instanceof Error ? e.message : String(e)}`,
          );
          // 页面不存在 / 被删：这不是网络故障，只是没有标签可抓。
          if (status === 404 || status === 410) {
            outcome = 'empty';
            consecutiveFailures.set(host, 0);
            break;
          }
          if (attempt === ATTEMPTS) {
            outcome = 'failed';
            const n = (consecutiveFailures.get(host) ?? 0) + 1;
            consecutiveFailures.set(host, n);
            // 站点开始卡：把下一条的间隔拉长，别继续往枪口上撞。
            gap = Math.min(MAX_GAP_MS, Math.round(gap * 2));
            if (n >= HOST_FAILURE_LIMIT) unreachableHosts.add(host);
            break;
          }
          await sleep(GAP_MS * attempt * 2);
        }
      }
    }

    if (outcome === 'ok') {
      try {
        await updateHistoryTags(t.id, tags, { onlyIfEmpty: true });
        ok += 1;
      } catch {
        failed += 1;
      }
    } else if (outcome === 'failed') {
      failed += 1;
    } else {
      // 抓到了页面但确实没有标签（或文章已删除）：把 tags 落成空数组 +
      // tags_checked_at，这样下一轮不会再重复抓同一条。
      try {
        await updateHistoryTags(t.id, [], { onlyIfEmpty: true });
        empty += 1;
      } catch {
        failed += 1;
      }
    }

    done += 1;
    // 顺利就慢慢恢复节奏（不低于基准间隔）。
    if (outcome === 'ok') {
      gap = Math.max(GAP_MS, Math.round(gap * 0.8));
    }
    report();
  }

  report();
  return {
    total,
    ok,
    empty,
    failed,
    stopped,
    unreachableHosts: Array.from(unreachableHosts),
  };
}

/** 仅测试/调试用。 */
export const _TAG_BACKFILL_INTERNALS = {
  GAP_MS,
  ATTEMPTS,
  HOST_FAILURE_LIMIT,
  hostOf,
  isTitleOnlyHost,
  hasNoTagsAtAll,
};
