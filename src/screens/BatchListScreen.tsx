import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';
import { formatLocalDateTime } from '../utils/time';
import type { RootStackParamList } from '../navigation/types';
import {
  isDownloaderAvailable,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import { parseArticle } from '../services/telegraphParser';
import { useDownload } from '../store/DownloadContext';
import {
  isIgnoringBatteryOptimizations,
  isNotifierSupported,
  requestIgnoreBatteryOptimizations,
} from '../services/downloadNotifier';
import {
  listDeletedUrlInfo,
  listHistoryByUrls,
  listListingSessions,
  listPreviousListingSelection,
  loadListingSession,
  markListingSelection,
  saveListingSession,
  type ListingSessionSummary,
} from '../services/historyService';
import {
  fetchEveriaPages,
  MAX_PAGES,
  type ListingEntry,
} from '../services/everiaListing';
import { dedupeUrls } from '../utils/batchScheduler';
import { confirmDownloadWithoutWifi } from '../utils/downloadNetworkGuard';
import { ArchivePicker } from '../components/ArchivePicker';
import {
  archiveHistoryUrl,
  importArchive,
  type ArchiveImportReason,
} from '../services/archiveImport';
import {
  inspectArchive,
  isArchiveSupported,
  subscribeArchiveProgress,
  type PickedArchive,
} from '../services/archiveService';
import type { BatchItem, BatchItemStatus } from '../types/batch';

/** Failure reason -> i18n key for archive rows. */
const ARCHIVE_REASON_KEY = {
  ENCRYPTED: 'archive.reason.encrypted',
  NO_IMAGES: 'archive.reason.noImages',
  TOO_LARGE: 'archive.reason.tooLarge',
  TOO_MANY_ENTRIES: 'archive.reason.tooManyEntries',
  UNREADABLE: 'archive.reason.unreadable',
  UNSUPPORTED: 'archive.reason.unsupported',
} as const satisfies Record<ArchiveImportReason, string>;

/**
 * Batch URL-download flow:
 *   1. Tap "选择 url.txt" → native SAF picker → content split into lines.
 *   2. Tap "开始" → scheduler iterates URLs serially:
 *      parseArticle(url) → on success call `downloadContext.runDownload(article)` →
 *      advance to next URL.
 *   3. Per-URL failures are skipped; pause/resume/skip/cancel affect the loop.
 */
/** 在线图集的数据源标识（落库 / 读取快照时用来区分站点）。 */
const ONLINE_SITE = 'everia.club';

export const BatchListScreen: React.FC = () => {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const downloadContext = useDownload();
  const { colors } = useTheme();
  // This screen renders inside the bottom-tab navigator, which is nested in
  // the root stack; `navigate('Preview', …)` bubbles up to the stack route.
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  /** In-app archive browser (解压压缩包) visibility. */
  const [showArchivePicker, setShowArchivePicker] = useState(false);
  /** URL whose row is currently parsing for a preview (spinner + press lock). */
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);
  /** 「刷新状态」正在查库（按钮显示转圈，防连点）。 */
  const [refreshingStatus, setRefreshingStatus] = useState(false);

  /* ---------------- 在线图集（everia.club 列表页） ---------------- */
  const [showOnline, setShowOnline] = useState(false);
  /** 勾选要抓取的列表页（默认 1-5，最多 10）。 */
  const [onlinePages, setOnlinePages] = useState<number[]>([1, 2, 3, 4, 5]);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [onlineEntries, setOnlineEntries] = useState<ListingEntry[]>([]);
  const [onlineSelected, setOnlineSelected] = useState<Set<string>>(
    () => new Set(),
  );
  const [onlineStats, setOnlineStats] = useState<{
    total: number;
    dup: number;
    downloaded: number;
  }>({ total: 0, dup: 0, downloaded: 0 });
  /** 正在放大查看的候选下标（null = 没打开）。 */
  const [onlinePreviewIndex, setOnlinePreviewIndex] = useState<number | null>(
    null,
  );
  /** 本次抓取的会话 id（落库用，也是「加入待下载」记勾选的依据）。 */
  const [onlineSessionId, setOnlineSessionId] = useState<number | null>(null);
  /** 面板当前视图：候选列表 / 历史抓取记录选择。 */
  const [onlineMode, setOnlineMode] = useState<'list' | 'history'>('list');
  const [onlineSessions, setOnlineSessions] = useState<ListingSessionSummary[]>(
    [],
  );
  const [onlineHistoryBusy, setOnlineHistoryBusy] = useState(false);
  /** 上次抓取时**没被勾选**的 URL（用于「上次未入选」提示）。 */
  const [onlinePrevUnselected, setOnlinePrevUnselected] = useState<Set<string>>(
    new Set(),
  );
  /** 以前下载过、后来被彻底删掉的 URL（墓碑表命中）。 */
  const [onlineDeleted, setOnlineDeleted] = useState<Map<string, number>>(
    new Map(),
  );
  const { width: windowWidth } = useWindowDimensions();
  const previewScrollRef = useRef<ScrollViewInstance>(null);

  const openPreviewAt = useCallback(
    (index: number) => {
      setOnlinePreviewIndex(index);
      // 打开后立刻定位到被点的那一张（不要动画，避免先闪第一张）。
      requestAnimationFrame(() => {
        previewScrollRef.current?.scrollTo({
          x: index * windowWidth,
          animated: false,
        });
      });
    },
    [windowWidth],
  );

  const closePreview = useCallback(() => setOnlinePreviewIndex(null), []);

  /** 滑到相邻候选：慢拖只触发 onScrollEndDrag，快速甩动才有 momentum，两个都挂。 */
  const onPreviewScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / windowWidth);
      if (idx >= 0 && idx < onlineEntries.length) setOnlinePreviewIndex(idx);
    },
    [onlineEntries.length, windowWidth],
  );

  const batchAbortRef = useRef<AbortController | null>(null);
  const pauseResumeRef = useRef<{
    paused: boolean;
    resumeWaiter: (() => void) | null;
  }>({ paused: false, resumeWaiter: null });

  // Reset on unmount so leaving the screen fully cancels any in-flight batch.
  useEffect(
    () => () => {
      const wasRunning = batchAbortRef.current != null;
      batchAbortRef.current?.abort();
      if (pauseResumeRef.current.resumeWaiter) {
        pauseResumeRef.current.resumeWaiter();
      }
      // Safety net: if the abort cannot unwind runBatch's finally promptly
      // (e.g. a parse stalled on a slow network), still release the
      // foreground service + wake lock when the screen goes away.
      // endBatchSession is a stable useCallback([]) in the provider, so the
      // first-render closure stays valid.
      if (wasRunning) downloadContext.endBatchSession();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handlePickFile = useCallback(async () => {
    if (!isDownloaderAvailable() || !TelegraphDownloader?.pickTextFile) {
      Alert.alert(
        t('settings.unsupported.title'),
        t('settings.unsupported.body'),
      );
      return;
    }
    let picked;
    try {
      picked = await TelegraphDownloader.pickTextFile();
    } catch (e) {
      // The native module rejects with "Another text-file picker is already
      // open" while a previous picker's result has not been delivered, and
      // may reject with other platform-level failures (e.g. activity not
      // attached). Surface the error to the user instead of letting the
      // unhandled rejection bring down the JS context.
      console.log('[BatchList] pickTextFile rejected', e);
      Alert.alert(
        t('settings.unsupported.title'),
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    if (!picked) return; // user cancelled
    // Split on any newline, strip BOM and blanks, dedupe within the file.
    const lines = dedupeUrls(picked.content.split(/\r?\n/));
    setItems(
      lines.map(url => ({
        url,
        status: 'pending' as BatchItemStatus,
        detail: '',
        progress: null,
      })),
    );
    setShowSummary(false);

    // Cross-batch dedup: query history for any URL that already has a
    // successful batch. Existing entries are flagged with `existing` so the
    // UI can render a "已下载" badge and the scheduler can skip them.
    try {
      const seen = await listHistoryByUrls(lines);
      if (seen.size === 0) return;
      setItems(prev =>
        prev.map(it => {
          const rec = seen.get(it.url);
          if (!rec) return it;
          return {
            ...it,
            existing: {
              historyId: rec.id,
              title: rec.title,
              imageCount: rec.imageCount,
              status: rec.status,
            },
            // Mark as "skipped" so the scheduler no-ops. The user can clear
            // it by tapping the row.
            status: 'skipped' as BatchItemStatus,
            detail: t('batch.status.alreadyDownloaded', {
              count: rec.imageCount,
            }),
          };
        }),
      );
    } catch (e) {
      // history lookup is best-effort; never block loading the list.
      console.log('[BatchList] listHistoryByUrls failed', e);
    }
  }, []);

  /**
   * 重新核对「待下载列表」里每条 URL 的状态：
   *   - 已经下载过（history 里有）→ existing + skipped
   *   - 以前下载过但被彻底删了（墓碑）→ deletedBefore 提示
   *
   * 在线图集挑出来的列表不会再走「重新选择 url.txt」，所以需要这个手动刷新。
   */
  const refreshItemsStatus = useCallback(async () => {
    if (running) return;
    const urls = items.filter(it => !it.archive).map(it => it.url);
    if (urls.length === 0) {
      Alert.alert(t('batch.refresh.none'));
      return;
    }
    setRefreshingStatus(true);
    try {
      const [seen, deleted] = await Promise.all([
        listHistoryByUrls(urls),
        listDeletedUrlInfo(urls),
      ]);
      setItems(prev =>
        prev.map(it => {
          if (it.archive) return it;
          const rec = seen.get(it.url);
          const at = deleted.get(it.url);
          const existing = rec
            ? {
                historyId: rec.id,
                title: rec.title,
                imageCount: rec.imageCount,
                status: rec.status,
              }
            : undefined;
          // 原来因为「已下载」被跳过、现在记录没了（被删）→ 回到等待
          const wasSkippedByExisting = !!it.existing && it.status === 'skipped';
          const status: BatchItemStatus = existing
            ? 'skipped'
            : wasSkippedByExisting
            ? 'pending'
            : it.status;
          const detail = existing
            ? t('batch.status.alreadyDownloaded', {
                count: existing.imageCount,
              })
            : wasSkippedByExisting
            ? ''
            : it.detail;
          return {
            ...it,
            existing,
            deletedBefore: at
              ? { title: rec?.title ?? '', deletedAt: at }
              : undefined,
            status,
            detail,
          };
        }),
      );
      Alert.alert(
        t('batch.refresh.doneTitle'),
        t('batch.refresh.doneBody', {
          downloaded: seen.size,
          deleted: deleted.size,
          pending: urls.length - seen.size,
        }),
      );
    } catch (e) {
      console.log('[BatchList] refreshItemsStatus failed', e);
      Alert.alert(t('batch.refresh.failed'));
    } finally {
      setRefreshingStatus(false);
    }
  }, [items, running]);

  /** 勾选 / 取消某个列表页。 */
  const toggleOnlinePage = useCallback((page: number) => {
    setOnlinePages(prev =>
      prev.includes(page)
        ? prev.filter(p => p !== page)
        : [...prev, page].sort((a, b) => a - b),
    );
  }, []);

  /**
   * 抓取选中的列表页 → 去重 → 过滤掉已经下载过的 → 生成待选列表。
   * 默认全选（用户通常就是想批量拿新的）。
   */
  const handleFetchOnline = useCallback(async () => {
    if (onlineBusy) return;
    if (onlinePages.length === 0) return;
    setOnlineBusy(true);
    setOnlineError('');
    setOnlineEntries([]);
    setOnlineSelected(new Set());
    try {
      const { entries, failedPages } = await fetchEveriaPages(onlinePages);

      // 1) 同一篇文章会在多个页面/推荐位重复出现 → 按 URL 去重
      const seen = new Set<string>();
      const unique: ListingEntry[] = [];
      for (const e of entries) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        unique.push(e);
      }

      // 2) 已经下载过的（历史里有同 URL 的记录）直接剔除
      let downloaded = 0;
      let fresh = unique;
      try {
        const seenHistory = await listHistoryByUrls(unique.map(e => e.url));
        if (seenHistory.size > 0) {
          fresh = unique.filter(e => !seenHistory.has(e.url));
          downloaded = unique.length - fresh.length;
        }
      } catch (e) {
        // 查询失败不阻塞：宁可多给几条，用户在列表里还能取消
        console.log('[BatchList] listHistoryByUrls failed', e);
      }

      setOnlineEntries(fresh);
      setOnlineSelected(new Set(fresh.map(e => e.url)));
      setOnlineStats({
        total: entries.length,
        dup: entries.length - unique.length,
        downloaded,
      });

      // 落库：每场抓取单独存一份，之后可以「历史列表」挑任意一场重新打开。
      // 「上次未入选」由上一场会话的勾选状态决定。
      const sessionId = Date.now();
      try {
        await saveListingSession(
          ONLINE_SITE,
          sessionId,
          { pages: onlinePages.join(','), total: entries.length },
          fresh,
        );
        setOnlineSessionId(sessionId);
        const prevSel = await listPreviousListingSelection(
          ONLINE_SITE,
          sessionId,
        );
        // 只有「上一场确实做过选择」（至少选了一条）才把未选的标出来，
        // 否则只是浏览了一遍也会被标成「未入选」，太吵。
        const anySelected = Array.from(prevSel.values()).some(Boolean);
        setOnlinePrevUnselected(
          anySelected
            ? new Set(
                Array.from(prevSel.entries())
                  .filter(([, sel]) => !sel)
                  .map(([u]) => u),
              )
            : new Set(),
        );
      } catch (e) {
        console.log('[BatchList] save listing session failed', e);
        setOnlinePrevUnselected(new Set());
      }
      try {
        setOnlineDeleted(await listDeletedUrlInfo(fresh.map(e => e.url)));
      } catch {
        setOnlineDeleted(new Map());
      }
      if (failedPages.length > 0) {
        setOnlineError(
          failedPages.length >= onlinePages.length
            ? t('batch.online.fetchFailed')
            : t('batch.online.failedPages', {
                pages: failedPages.join(', '),
              }),
        );
      }
    } catch (e) {
      setOnlineError(t('batch.online.fetchFailed'));
      console.log('[BatchList] fetch listing failed', e);
    } finally {
      setOnlineBusy(false);
    }
  }, [onlineBusy, onlinePages]);

  /** 把勾选的条目并入待下载列表（按 URL 去重，重复的不再加）。 */
  const handleAddOnline = useCallback(() => {
    const picked = onlineEntries.filter(e => onlineSelected.has(e.url));
    if (picked.length === 0) return;
    // 记住这次勾了哪些：下次抓取时，没勾的会显示「上次未入选」。
    if (onlineSessionId != null) {
      markListingSelection(
        onlineSessionId,
        picked.map(e => e.url),
      ).catch(() => undefined);
    }
    setItems(prev => {
      const have = new Set(prev.map(it => it.url));
      const add = picked
        .filter(e => !have.has(e.url))
        .map(e => ({
          url: e.url,
          title: e.title,
          preview: e.preview,
          status: 'pending' as BatchItemStatus,
          detail: '',
          progress: null,
        }));
      return [...prev, ...add];
    });
    setShowOnline(false);
  }, [onlineEntries, onlineSelected, onlineSessionId]);

  /**
   * 打开「历史抓取」列表（不联网）：用户可以挑任意一次抓取结果重新打开，
   * 而不是只能读最后那一次。
   */
  const openOnlineHistory = useCallback(async () => {
    if (onlineBusy) return;
    setOnlineError('');
    setOnlineMode('history');
    setOnlineHistoryBusy(true);
    try {
      setOnlineSessions(await listListingSessions(ONLINE_SITE, 50));
    } catch (e) {
      console.log('[BatchList] list listing sessions failed', e);
      setOnlineSessions([]);
    } finally {
      setOnlineHistoryBusy(false);
    }
  }, [onlineBusy]);

  /** 打开历史里选中的那一场（不联网），已下载过的仍然剔除。 */
  const openListingSession = useCallback(async (sessionId: number) => {
    setOnlineHistoryBusy(true);
    setOnlineError('');
    try {
      const session = await loadListingSession(sessionId);
      if (!session || session.items.length === 0) {
        Alert.alert(t('batch.online.noLast'));
        return;
      }
      let rows = session.items;
      let downloaded = 0;
      try {
        const seenHistory = await listHistoryByUrls(rows.map(i => i.url));
        if (seenHistory.size > 0) {
          rows = rows.filter(i => !seenHistory.has(i.url));
          downloaded = session.items.length - rows.length;
        }
      } catch (e) {
        console.log('[BatchList] listHistoryByUrls failed', e);
      }
      setOnlineSessionId(session.sessionId);
      setOnlineEntries(
        rows.map(i => ({ url: i.url, title: i.title, preview: i.preview })),
      );
      // 沿用那一场记下的勾选。
      setOnlineSelected(new Set(rows.filter(i => i.selected).map(i => i.url)));
      setOnlineStats({
        total: session.items.length,
        dup: 0,
        downloaded,
      });
      // 「上次未入选」对历史快照没有意义（它就是历史本身）。
      setOnlinePrevUnselected(new Set());
      try {
        setOnlineDeleted(await listDeletedUrlInfo(rows.map(i => i.url)));
      } catch {
        setOnlineDeleted(new Map());
      }
      setOnlineMode('list');
    } catch (e) {
      console.log('[BatchList] open listing session failed', e);
      setOnlineError(t('batch.online.fetchFailed'));
    } finally {
      setOnlineHistoryBusy(false);
    }
  }, []);

  const toggleOnlineSelect = useCallback((url: string) => {
    setOnlineSelected(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const toggleOnlineAll = useCallback(() => {
    setOnlineSelected(prev =>
      prev.size === onlineEntries.length
        ? new Set()
        : new Set(onlineEntries.map(e => e.url)),
    );
  }, [onlineEntries]);

  const updateItem = useCallback(
    (
      index: number,
      patchOrFn: Partial<BatchItem> | ((prev: BatchItem) => BatchItem),
    ) => {
      setItems(prev => {
        if (index < 0 || index >= prev.length) return prev;
        const current = prev[index]!;
        const patch =
          typeof patchOrFn === 'function'
            ? patchOrFn(current)
            : { ...current, ...patchOrFn };
        const next = prev.slice();
        next[index] = patch;
        return next;
      });
    },
    [],
  );

  const waitIfPaused = useCallback(async () => {
    if (!pauseResumeRef.current.paused) return;
    await new Promise<void>(resolve => {
      pauseResumeRef.current.resumeWaiter = resolve;
    });
    pauseResumeRef.current.resumeWaiter = null;
  }, []);

  /** Drop one row from the list (archives are removed by long-press). */
  const removeItem = useCallback((index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * 清除整个 URL 列表（返回「选择 txt 文件 / 选择压缩包」的空状态）。
   * 只清队列，不动已经下载下来的图片，所以要二次确认。
   */
  const handleClearList = useCallback(() => {
    if (items.length === 0 || running) return;
    Alert.alert(
      t('batch.clearTitle'),
      t('batch.clearBody', { count: items.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('batch.clear'),
          style: 'destructive',
          onPress: () => {
            setItems([]);
            setPaused(false);
            setShowSummary(false);
          },
        },
      ],
    );
  }, [items.length, running]);

  /** Row currently being extracted, so progress events land on the right row. */
  const archiveRowRef = useRef<number | null>(null);

  // Native extraction ticks (done/total) drive the row's progress bar.
  useEffect(() => {
    if (!isArchiveSupported()) return undefined;
    return subscribeArchiveProgress(p => {
      const index = archiveRowRef.current;
      if (index == null) return;
      updateItem(index, {
        status: 'downloading',
        detail: t('archive.progress', { done: p.done, total: p.total }),
        progress: { cur: p.done, total: p.total },
      });
    });
  }, [updateItem]);

  /** Queue the archives chosen in the in-app browser. */
  const handlePickArchives = useCallback(async (picked: PickedArchive[]) => {
    if (picked.length === 0) return;
    setShowSummary(false);
    // Inspect each pick up-front so an archive that was already imported (even
    // under a different file name) is marked "already imported" instead of
    // being extracted again. Reading the central directory is cheap.
    const rows: BatchItem[] = [];
    for (const item of picked) {
      const info = await inspectArchive(item.uri);
      const fingerprint = info.ok ? info.fingerprint : undefined;
      const existing = fingerprint
        ? (await listHistoryByUrls([archiveHistoryUrl(fingerprint)])).get(
            archiveHistoryUrl(fingerprint),
          )
        : undefined;
      rows.push({
        url: item.name,
        status: existing ? 'skipped' : ('pending' as BatchItemStatus),
        detail: existing
          ? t('archive.alreadyImported', { count: existing.imageCount })
          : '',
        progress: null,
        archive: { uri: item.uri, name: item.name },
      });
    }
    setItems(prev => {
      const seen = new Set(prev.map(it => it.archive?.uri).filter(Boolean));
      return [...prev, ...rows.filter(r => !seen.has(r.archive?.uri))];
    });
  }, []);

  const runBatch = useCallback(async () => {
    if (running || items.length === 0) return;
    if (batchAbortRef.current) return;
    setRunning(true);
    setPaused(false);
    setShowSummary(false);

    // Background keep-alive prep (Android-only, best-effort):
    //   1. Offer the battery-optimization whitelist when the app is not
    //      exempt yet — Doze/vendor power management can otherwise freeze a
    //      long batch even with a foreground service running.
    //   2. Bring up the foreground service NOW, while the app is in the
    //      foreground (Android 12+ refuses to start one from the
    //      background), and keep it up for the WHOLE batch: tearing it down
    //      between URLs would leave parsing gaps unprotected.
    if (isNotifierSupported()) {
      try {
        const ignoring = await isIgnoringBatteryOptimizations();
        if (!ignoring) await requestIgnoreBatteryOptimizations();
      } catch {
        // best-effort; the user can whitelist manually in system settings
      }
      downloadContext.beginBatchSession(t('batch.fgsTitle'));
    }

    batchAbortRef.current = new AbortController();
    const signal = batchAbortRef.current.signal;
    let done = 0;
    let failed = 0;
    let skipped = 0;
    // Aggregate per-image totals across all articles; handed to
    // endBatchSession so the batch-end completion notification can show the
    // real numbers even when the user is in another app.
    let imgSuccess = 0;
    let imgFailed = 0;
    let imgSkipped = 0;
    try {
      for (let i = 0; i < items.length; i += 1) {
        if (signal.aborted) break;
        if (items[i]?.status === 'skipped') {
          skipped += 1;
          continue;
        }
        await waitIfPaused();
        if (signal.aborted) break;

        // Archive rows: extract straight into the gallery instead of fetching a
        // page and downloading its images.
        const archive = items[i]?.archive;
        if (archive) {
          archiveRowRef.current = i;
          updateItem(i, {
            status: 'downloading',
            detail: t('archive.extracting'),
            progress: null,
          });
          try {
            const result = await importArchive(archive.uri, archive.name);
            if (result.reason) {
              updateItem(i, {
                status: 'failed',
                detail: t(ARCHIVE_REASON_KEY[result.reason]),
                progress: null,
              });
              failed += 1;
            } else {
              updateItem(i, {
                status: result.failed > 0 ? 'failed' : 'done',
                detail: t('batch.status.counts', {
                  success: result.success,
                  skipped: result.skipped,
                  failed: result.failed,
                }),
                progress: null,
              });
              if (result.failed > 0) failed += 1;
              else done += 1;
            }
          } catch {
            updateItem(i, {
              status: 'failed',
              detail: t(ARCHIVE_REASON_KEY.UNREADABLE),
              progress: null,
            });
            failed += 1;
          }
          archiveRowRef.current = null;
          continue;
        }

        updateItem(i, { status: 'parsing', detail: '', progress: null });

        let result;
        try {
          result = await parseArticle(items[i].url, { signal });
        } catch {
          updateItem(i, { status: 'failed', detail: '解析异常' });
          failed += 1;
          continue;
        }
        if (
          !result.ok ||
          !result.article ||
          result.article.images.length === 0
        ) {
          updateItem(i, {
            status: 'failed',
            detail: result.error?.message ?? '无图',
          });
          failed += 1;
          continue;
        }

        updateItem(i, {
          status: 'downloading',
          detail: `下载中 0/${result.article.images.length}`,
          progress: { cur: 0, total: result.article.images.length },
        });
        try {
          const summary = await downloadContext.runDownload(result.article, {
            signal,
            onProgress: (cur, total) => {
              updateItem(i, {
                status: 'downloading',
                detail: `下载中 ${cur}/${total}`,
                progress: { cur, total },
              });
            },
          });
          imgSuccess += summary.success;
          imgFailed += summary.failed;
          imgSkipped += summary.skipped;
          // Resolving only means the queue drained — it says nothing about
          // whether any image was actually saved. Surface the real per-image
          // counts so an article whose every image failed is shown as failed
          // instead of "done".
          const counts = t('batch.status.counts', {
            success: summary.success,
            skipped: summary.skipped,
            failed: summary.failed,
          });
          const allFailed =
            summary.failed > 0 &&
            summary.success === 0 &&
            summary.skipped === 0;
          // On total failure show the reason alone; otherwise prefix the counts
          // with the first error so partial failures stay visible.
          const reason = summary.firstError;
          let detail = counts;
          if (allFailed) detail = reason ?? counts;
          else if (reason) detail = `${counts} · ${reason}`;
          updateItem(i, {
            status: allFailed ? 'failed' : 'done',
            detail,
            progress: null,
          });
          if (allFailed) failed += 1;
          else done += 1;
        } catch {
          updateItem(i, {
            status: 'failed',
            detail: '下载失败',
            progress: null,
          });
          failed += 1;
        }
      }
    } finally {
      // Release the foreground service + wake lock once the whole batch is
      // done (or was cancelled / the screen unmounted mid-run). On a normal
      // finish pass the aggregate counts so the completion notification is
      // shown before the service is dismissed; on cancel stop immediately.
      downloadContext.endBatchSession(
        signal.aborted
          ? undefined
          : { success: imgSuccess, failed: imgFailed, skipped: imgSkipped },
      );
      batchAbortRef.current = null;
      setRunning(false);
      setPaused(false);
      setShowSummary(true);
    }
    Alert.alert(
      t('batch.summaryTitle'),
      t('batch.summaryBody', {
        done,
        failed,
        skipped,
        total: items.length,
      }),
    );
  }, [items, running, updateItem, waitIfPaused, downloadContext]);

  const handleStart = useCallback(() => {
    // A batch can move hundreds of megabytes: confirm first when the phone is
    // on mobile data. Archive rows extract locally, so they don't need the
    // warning — only ask when the batch actually contains URL rows.
    const hasUrlRows = items.some(it => !it.archive);
    const proceed = () => runBatch().catch(() => undefined);
    if (!hasUrlRows) {
      proceed();
      return;
    }
    // If the check itself fails, never block the download.
    confirmDownloadWithoutWifi()
      .catch(() => true)
      .then(ok => {
        if (ok) proceed();
      });
  }, [items, runBatch]);

  const handlePauseToggle = useCallback(() => {
    if (!running) return;
    setPaused(prev => {
      const next = !prev;
      pauseResumeRef.current.paused = next;
      if (!next && pauseResumeRef.current.resumeWaiter) {
        const wake = pauseResumeRef.current.resumeWaiter;
        pauseResumeRef.current.resumeWaiter = null;
        wake();
      }
      // Pause/resume the queue when running so it stops pulling tasks.
      if (next) downloadContext.pause();
      else downloadContext.resume();
      return next;
    });
  }, [running, downloadContext]);

  const handleSkipCurrent = useCallback(() => {
    if (!running) return;
    // Mark every currently downloading row as skipped and let the cancel
    // call the queue's "stopped" path. The scheduler's `signal.aborted` does
    // not fire here because we only want the in-flight task to abort, not
    // the whole batch.
    setItems(prev => {
      const next = prev.slice();
      for (let j = 0; j < next.length; j += 1) {
        if (next[j].status === 'parsing' || next[j].status === 'downloading') {
          next[j] = { ...next[j], status: 'skipped', progress: null };
        }
      }
      return next;
    });
    downloadContext.cancel();
  }, [running, downloadContext]);

  const handleCancelAll = useCallback(() => {
    batchAbortRef.current?.abort();
    if (pauseResumeRef.current.resumeWaiter) {
      pauseResumeRef.current.resumeWaiter();
    }
    downloadContext.cancel();
    setItems(prev => {
      const next = prev.slice();
      for (let j = 0; j < next.length; j += 1) {
        if (next[j].status !== 'done' && next[j].status !== 'failed') {
          next[j] = { ...next[j], status: 'skipped', progress: null };
        }
      }
      return next;
    });
    setRunning(false);
    setPaused(false);
  }, [downloadContext]);

  const summary = useMemo(() => {
    let done = 0;
    let failed = 0;
    let skipped = 0;
    for (const it of items) {
      if (it.status === 'done') done += 1;
      else if (it.status === 'failed') failed += 1;
      else if (it.status === 'skipped') skipped += 1;
    }
    return { done, failed, skipped };
  }, [items]);

  // Long-press a row to re-queue it (mainly for "已下载" rows the user wants
  // to re-download). Toggles between 'skipped' (with the existing flag) and
  // 'pending'. Tap is reserved for opening the image preview.
  const requeueItem = useCallback(
    (index: number) => {
      updateItem(index, prev => {
        if (prev.existing) {
          // Was auto-skipped because already in history. Clear the flag and
          // put back in the queue.
          return {
            url: prev.url,
            status: 'pending' as BatchItemStatus,
            detail: '',
            progress: null,
          };
        }
        if (prev.status === 'skipped') {
          return { ...prev, status: 'pending' as BatchItemStatus, detail: '' };
        }
        return prev;
      });
    },
    [updateItem],
  );

  const requeueAllMissing = useCallback(() => {
    setItems(prev =>
      prev.map(it =>
        it.existing
          ? {
              ...it,
              existing: undefined,
              status: 'pending' as BatchItemStatus,
              detail: '',
            }
          : it,
      ),
    );
  }, []);

  // Tap a URL row -> parse it and open the image preview page (the same
  // Preview screen the Home flow pushes), so the user can inspect / hand-pick
  // images before committing to a download.
  const openPreview = useCallback(
    async (item: BatchItem, index: number) => {
      if (running || previewingUrl) return;
      setPreviewingUrl(item.url);
      try {
        const result = await parseArticle(item.url);
        if (result.ok && result.article && result.article.images.length > 0) {
          // Reflect the parsed image count on the row without touching its
          // batch status (an `existing` row must stay flagged as skipped).
          updateItem(index, { detail: `${result.article.images.length} 张` });
          navigation.navigate('Preview', { article: result.article });
        } else {
          Alert.alert(
            t('batch.previewFailTitle'),
            result.error?.message ?? t('batch.previewNoImages'),
          );
        }
      } catch (e) {
        Alert.alert(
          t('batch.previewFailTitle'),
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setPreviewingUrl(null);
      }
    },
    [running, previewingUrl, updateItem, navigation],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: BatchItem; index: number }) => {
      const color =
        item.status === 'done'
          ? '#2e7d32'
          : item.status === 'failed'
          ? '#c62828'
          : item.status === 'skipped'
          ? '#999'
          : item.status === 'parsing' || item.status === 'downloading'
          ? colors.primary
          : colors.textSecondary;
      const labelKey =
        item.status === 'pending'
          ? 'batch.status.pending'
          : item.status === 'parsing'
          ? 'batch.status.parsing'
          : item.status === 'downloading'
          ? 'batch.status.downloading'
          : item.status === 'done'
          ? 'batch.status.done'
          : item.status === 'failed'
          ? 'batch.status.failed'
          : 'batch.status.skipped';
      const label = t(labelKey, item.progress ?? {});
      const isArchive = !!item.archive;
      // Archive rows have no URL to preview; long-pressing removes them.
      const isReQueueable =
        !isArchive && (!!item.existing || item.status === 'skipped');
      const isPreviewing = !isArchive && previewingUrl === item.url;
      return (
        <Pressable
          onPress={isArchive ? undefined : () => openPreview(item, index)}
          onLongPress={
            isArchive
              ? running
                ? undefined
                : () => removeItem(index)
              : isReQueueable && !running
              ? () => requeueItem(index)
              : undefined
          }
          disabled={isPreviewing}
          style={({ pressed }) => [
            styles.row,
            styles.rowPressable,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.rowMain}>
            {item.preview ? (
              <Image
                source={{ uri: item.preview }}
                style={styles.rowThumb}
                resizeMode="cover"
              />
            ) : null}
            <View style={styles.rowText}>
              <Text style={[styles.rowUrl]} numberOfLines={1}>
                {index + 1}. {item.title || item.url}
              </Text>
              <Text
                style={[
                  styles.rowStatus,
                  { color: isPreviewing ? colors.primary : color },
                ]}
              >
                {isPreviewing ? t('batch.status.parsing') : label}
                {!isPreviewing && item.detail ? ` · ${item.detail}` : ''}
              </Text>
              {item.existing && !isPreviewing ? (
                <Text style={styles.rowHistory} numberOfLines={1}>
                  ↩ {item.existing.title} · {t('batch.longPressRequeue')}
                </Text>
              ) : null}
              {item.deletedBefore && !isPreviewing ? (
                <Text style={styles.rowDeleted} numberOfLines={1}>
                  🗑 {t('batch.deletedBefore')}
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>
      );
    },
    // `t` is intentionally not listed: it comes from I18nContext and the
    // component subscribes via useI18n() at the top, so re-renders happen
    // automatically on language change.
    [
      styles,
      colors.primary,
      colors.textSecondary,
      requeueItem,
      openPreview,
      previewingUrl,
      running,
      removeItem,
    ],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.body}>
        <Text style={styles.intro}>{t('batch.intro')}</Text>
        {items.length === 0 ? (
          <View style={styles.pickRow}>
            <Pressable
              onPress={handlePickFile}
              style={({ pressed }) => [
                styles.pickBtn,
                styles.pickBtnPrimary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.pickBtnText} numberOfLines={1}>
                {t('batch.pickFile')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setShowArchivePicker(true)}
              style={({ pressed }) => [
                styles.pickBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.pickBtnText} numberOfLines={1}>
                {t('archive.pickArchives')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setShowOnline(true)}
              style={({ pressed }) => [
                styles.pickBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.pickBtnText} numberOfLines={1}>
                {t('batch.online.open')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.fileRow}>
              <Text style={styles.fileLabel} numberOfLines={1}>
                📄 {items.length} 条
              </Text>
              <Pressable
                onPress={handlePickFile}
                style={({ pressed }) => [
                  styles.repickBtn,
                  pressed && styles.pressed,
                ]}
                disabled={running}
              >
                <Text style={styles.repickBtnText}>
                  {t('batch.repickFile')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowArchivePicker(true)}
                style={({ pressed }) => [
                  styles.repickBtn,
                  pressed && styles.pressed,
                ]}
                disabled={running}
              >
                <Text style={styles.repickBtnText}>
                  {t('archive.pickArchives')}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setShowOnline(true)}
                style={({ pressed }) => [
                  styles.repickBtn,
                  pressed && styles.pressed,
                  running && styles.pressedDisabled,
                ]}
                disabled={running}
              >
                <Text style={styles.repickBtnText}>
                  {t('batch.online.open')}
                </Text>
              </Pressable>
            </View>
            <FlatList
              data={items}
              keyExtractor={(it, i) => `${i}:${it.url}`}
              renderItem={renderItem}
              style={styles.list}
              contentContainerStyle={styles.listContent}
            />
            {items.some(it => it.existing) ? (
              <View style={styles.skipHintRow}>
                <Text style={styles.skipHintText}>
                  {t('batch.skipExistingHint')}
                </Text>
                <Pressable
                  onPress={requeueAllMissing}
                  style={({ pressed }) => [
                    styles.smallBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.smallBtnText}>
                    {t('batch.requeueAllMissing')}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            <Text style={styles.progress}>
              {t('batch.progress', {
                cur: summary.done + summary.failed + summary.skipped,
                total: items.length,
                done: summary.done,
                failed: summary.failed,
              })}
            </Text>
            <View style={styles.actions}>
              {!running ? (
                <>
                  <Pressable
                    onPress={handleStart}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      styles.actionBtnPrimary,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.actionBtnText}>{t('batch.start')}</Text>
                  </Pressable>
                  <Pressable
                    onPress={refreshItemsStatus}
                    accessibilityRole="button"
                    accessibilityLabel={t('batch.refresh.button')}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.pressed,
                      refreshingStatus && styles.pressedDisabled,
                    ]}
                    disabled={refreshingStatus}
                  >
                    <Text style={styles.actionBtnText}>
                      {refreshingStatus
                        ? t('batch.refresh.running')
                        : t('batch.refresh.button')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleClearList}
                    accessibilityRole="button"
                    accessibilityLabel={t('batch.clear')}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[styles.actionBtnText, styles.actionBtnTextDanger]}
                    >
                      {t('batch.clear')}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    onPress={handlePauseToggle}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.actionBtnText}>
                      {paused ? t('batch.resume') : t('batch.pause')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSkipCurrent}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.actionBtnText}>
                      {t('batch.skipCurrent')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleCancelAll}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      styles.actionBtnDanger,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.actionBtnText}>
                      {t('batch.cancelAll')}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </>
        )}
        {running ? (
          <View style={styles.spinner}>
            <ActivityIndicator />
          </View>
        ) : null}
        {showSummary && items.length > 0 && !running ? (
          <Pressable
            onPress={() => setShowSummary(false)}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
          >
            <Text style={styles.dismissText}>{t('common.cancel')}</Text>
          </Pressable>
        ) : null}
      </View>
      {/* 解压压缩包: in-app browser (only archives are listed, and archives
          imported before are marked as already done). */}
      <ArchivePicker
        visible={showArchivePicker}
        onClose={() => setShowArchivePicker(false)}
        onPick={picked => {
          handlePickArchives(picked).catch(() => undefined);
        }}
      />

      {/* 在线图集：从 everia.club 列表页抓「文章 + 一张预览图」，勾选后并入待下载 */}
      <Modal
        visible={showOnline}
        animationType="slide"
        onRequestClose={() => setShowOnline(false)}
      >
        <SafeAreaView style={styles.onlineSafe} edges={['top', 'bottom']}>
          <View style={styles.onlineHeader}>
            <Text style={styles.onlineTitle}>{t('batch.online.title')}</Text>
            <Pressable
              onPress={() => setShowOnline(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
            >
              <Text style={styles.onlineClose}>×</Text>
            </Pressable>
          </View>

          {onlineMode === 'history' ? (
            <View style={styles.onlineHistoryWrap}>
              <Text style={styles.onlineHint}>
                {t('batch.online.historyHint')}
              </Text>
              {onlineHistoryBusy ? (
                <View style={styles.onlineHistoryBusy}>
                  <ActivityIndicator />
                </View>
              ) : onlineSessions.length === 0 ? (
                <Text style={styles.onlineEmpty}>
                  {t('batch.online.noHistory')}
                </Text>
              ) : (
                <FlatList
                  data={onlineSessions}
                  keyExtractor={s => String(s.sessionId)}
                  style={styles.onlineList}
                  contentContainerStyle={styles.onlineListContent}
                  renderItem={({ item: s }) => (
                    <Pressable
                      onPress={() => {
                        openListingSession(s.sessionId).catch(() => undefined);
                      }}
                      style={({ pressed }) => [
                        styles.onlineSessionRow,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.onlineRowText}>
                        <Text style={styles.onlineSessionTime}>
                          {formatLocalDateTime(s.sessionId)}
                        </Text>
                        <Text style={styles.onlineSessionMeta}>
                          {t('batch.online.sessionMeta', {
                            pages: s.pages || '-',
                            total: s.total,
                            selected: s.selectedCount,
                          })}
                        </Text>
                      </View>
                      <Text style={styles.onlineSessionChevron}>›</Text>
                    </Pressable>
                  )}
                />
              )}
              <View style={styles.onlineFooter}>
                <Pressable
                  onPress={() => setOnlineMode('list')}
                  style={({ pressed }) => [
                    styles.onlineAddBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.onlineAddText}>{t('common.back')}</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              <Text style={styles.onlineHint}>
                {t('batch.online.pagesHint')}
              </Text>
              <View style={styles.onlinePages}>
                {Array.from({ length: MAX_PAGES }, (_, i) => i + 1).map(p => {
                  const on = onlinePages.includes(p);
                  return (
                    <Pressable
                      key={p}
                      onPress={() => toggleOnlinePage(p)}
                      style={({ pressed }) => [
                        styles.pageChip,
                        on && styles.pageChipOn,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.pageChipText,
                          on && styles.pageChipTextOn,
                        ]}
                      >
                        {p}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.onlineActions}>
                <Pressable
                  onPress={handleFetchOnline}
                  disabled={onlineBusy || onlinePages.length === 0}
                  style={({ pressed }) => [
                    styles.onlineFetchBtn,
                    (onlineBusy || onlinePages.length === 0) &&
                      styles.pressedDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {onlineBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.onlineFetchText}>
                      {t('batch.online.fetch')}
                    </Text>
                  )}
                </Pressable>
                {onlineEntries.length > 0 ? (
                  <Pressable
                    onPress={toggleOnlineAll}
                    style={({ pressed }) => [
                      styles.smallBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.smallBtnText}>
                      {onlineSelected.size === onlineEntries.length
                        ? t('batch.online.selectNone')
                        : t('batch.online.selectAll')}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={openOnlineHistory}
                  disabled={onlineBusy}
                  style={({ pressed }) => [
                    styles.smallBtn,
                    onlineBusy && styles.pressedDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.smallBtnText}>
                    {t('batch.online.history')}
                  </Text>
                </Pressable>
              </View>

              {onlineError ? (
                <Text style={styles.onlineError}>{onlineError}</Text>
              ) : null}
              {onlineStats.total > 0 ? (
                <Text style={styles.onlineStats}>
                  {t('batch.online.stats', {
                    total: onlineStats.total,
                    dup: onlineStats.dup,
                    downloaded: onlineStats.downloaded,
                  })}
                </Text>
              ) : null}

              <FlatList
                data={onlineEntries}
                keyExtractor={e => e.url}
                style={styles.onlineList}
                contentContainerStyle={styles.onlineListContent}
                ListEmptyComponent={
                  onlineBusy ? undefined : (
                    <Text style={styles.onlineEmpty}>
                      {t('batch.online.empty')}
                    </Text>
                  )
                }
                renderItem={({ item: e, index: ei }) => {
                  const on = onlineSelected.has(e.url);
                  return (
                    <Pressable
                      onPress={() => toggleOnlineSelect(e.url)}
                      style={({ pressed }) => [
                        styles.onlineRow,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View
                        style={[styles.onlineCheck, on && styles.onlineCheckOn]}
                      >
                        {on ? (
                          <Text style={styles.onlineCheckMark}>✓</Text>
                        ) : null}
                      </View>
                      {e.preview ? (
                        <Pressable
                          onPress={() => openPreviewAt(ei)}
                          accessibilityRole="imagebutton"
                          accessibilityLabel={t('batch.online.previewOpen')}
                          hitSlop={4}
                          style={({ pressed }) => [
                            styles.onlineThumbHit,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Image
                            source={{ uri: e.preview }}
                            style={styles.onlineThumb}
                            resizeMode="cover"
                          />
                        </Pressable>
                      ) : (
                        <View
                          style={[styles.onlineThumb, styles.onlineThumbEmpty]}
                        />
                      )}
                      <View style={styles.onlineRowText}>
                        <Text style={styles.onlineRowTitle} numberOfLines={2}>
                          {e.title}
                        </Text>
                        {onlineDeleted.has(e.url) ? (
                          <Text
                            style={styles.onlineBadgeWarn}
                            numberOfLines={1}
                          >
                            🗑 {t('batch.online.badgeDeleted')}
                          </Text>
                        ) : onlinePrevUnselected.has(e.url) ? (
                          <Text
                            style={styles.onlineBadgeMuted}
                            numberOfLines={1}
                          >
                            {t('batch.online.badgeUnselected')}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                }}
              />

              <View style={styles.onlineFooter}>
                <Text style={styles.onlineCount}>
                  {t('batch.online.add', { count: onlineSelected.size })}
                </Text>
                <Pressable
                  onPress={handleAddOnline}
                  disabled={onlineSelected.size === 0}
                  style={({ pressed }) => [
                    styles.onlineAddBtn,
                    onlineSelected.size === 0 && styles.pressedDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.onlineAddText}>
                    {t('batch.online.addBtn')}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </SafeAreaView>
      </Modal>

      {/* 预览大图：点在线图集里的缩略图打开。左右滑动看相邻候选，
          顶栏可直接把这个候选加入/移出待下载。放在这里（而不是嵌在上面那个
          Modal 里）是为了避免 Android 上 Modal 套 Modal 的返回键/层级问题。 */}
      <Modal
        visible={onlinePreviewIndex !== null && onlineEntries.length > 0}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closePreview}
      >
        <View style={styles.previewRoot}>
          <SafeAreaView style={styles.previewBar} edges={['top']}>
            <View style={styles.previewBarRow}>
              <Pressable
                onPress={closePreview}
                hitSlop={12}
                style={styles.previewCloseBtn}
                accessibilityRole="button"
                accessibilityLabel={t('batch.online.previewClose')}
              >
                <Text style={styles.previewCloseText}>×</Text>
              </Pressable>
              {/* 页码绝对居中：两侧按钮宽度变化也不会把它挤偏。 */}
              <View pointerEvents="none" style={styles.previewCounterWrap}>
                <Text style={styles.previewCounter}>
                  {t('preview.viewerIndex', {
                    current: (onlinePreviewIndex ?? 0) + 1,
                    total: onlineEntries.length,
                  })}
                </Text>
              </View>
              {(() => {
                const entry =
                  onlinePreviewIndex != null
                    ? onlineEntries[onlinePreviewIndex]
                    : undefined;
                if (!entry) return null;
                const on = onlineSelected.has(entry.url);
                return (
                  <Pressable
                    onPress={() => toggleOnlineSelect(entry.url)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={({ pressed }) => [
                      styles.previewSelectBtn,
                      on && styles.previewSelectBtnOn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.previewSelectText,
                        on && styles.previewSelectTextOn,
                      ]}
                    >
                      {on
                        ? t('batch.online.selected')
                        : t('batch.online.select')}
                    </Text>
                  </Pressable>
                );
              })()}
            </View>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {onlinePreviewIndex != null
                ? onlineEntries[onlinePreviewIndex]?.title ?? ''
                : ''}
            </Text>
          </SafeAreaView>

          <ScrollView
            ref={previewScrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            style={styles.previewPager}
            onMomentumScrollEnd={onPreviewScrollEnd}
            onScrollEndDrag={onPreviewScrollEnd}
          >
            {onlineEntries.map(entry => (
              <PreviewPage
                key={entry.url}
                uri={entry.preview}
                width={windowWidth}
                onPress={closePreview}
              />
            ))}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

/**
 * 预览大图的单页。每页各自管自己的加载状态：滑到哪张才真正加载哪张，
 * 避免 100 多个候选一次性全下载。
 */
const PreviewPage: React.FC<{
  uri: string;
  width: number;
  onPress: () => void;
}> = React.memo(({ uri, width, onPress }) => {
  const styles = useThemedStyles(createStyles);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  return (
    <Pressable style={[styles.previewPage, { width }]} onPress={onPress}>
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.previewImage}
          resizeMode="contain"
          // 图片不接收触摸：点击穿透到整页的关闭手势。
          pointerEvents="none"
          onLoadStart={() => {
            setLoading(true);
            setFailed(false);
          }}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        />
      ) : null}
      {loading && !failed ? (
        <View style={styles.previewSpinner} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
      {failed ? (
        <Text style={styles.previewFailed}>
          {t('batch.online.previewFailed')}
        </Text>
      ) : null}
    </Pressable>
  );
});
PreviewPage.displayName = 'PreviewPage';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    body: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
    intro: { fontSize: 13, color: c.textSecondary, marginBottom: 12 },
    pickRow: { flexDirection: 'row', gap: 8 },
    pickBtn: {
      flex: 1,
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 6,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** 主入口（选择 url.txt）比旁边两个更宽，字更长也放得下。 */
    pickBtnPrimary: { flex: 1.8 },
    pickBtnText: {
      color: c.textOnPrimary,
      fontWeight: '600',
      fontSize: 12,
      textAlign: 'center',
    },
    pressed: { opacity: 0.6 },
    fileRow: {
      flexDirection: 'row',
      // 5 个按钮（重新选择/选择压缩包/清除/刷新状态/在线图集）放不下一行：
      // 允许换行，窄屏上第二行继续排，而不是被挤出屏幕。
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-start',
      marginBottom: 8,
      columnGap: 10,
      rowGap: 6,
    },
    fileLabel: { fontSize: 13, color: c.textPrimary, marginRight: 'auto' },
    repickBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: c.surfaceStrong,
    },
    repickBtnText: { color: c.textPrimary, fontSize: 12, fontWeight: '500' },
    /** 「清除」用警示色，和旁边两个普通操作区分开。 */
    repickBtnDanger: { color: c.danger, fontSize: 12, fontWeight: '500' },
    /** 运行中禁用的浅色状态（清除 / 重新选择都靠它）。 */
    pressedDisabled: { opacity: 0.45 },
    list: { flex: 1 },
    listContent: { paddingBottom: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      backgroundColor: c.surfaceStrong,
      borderRadius: 6,
      marginBottom: 6,
    },
    rowPressable: { opacity: 0.85 },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
    /** 待下载列表里的封面缩略图（在线图集带过来的预览）。 */
    rowThumb: {
      width: 44,
      height: 58,
      borderRadius: 4,
      backgroundColor: c.surface,
    },
    rowText: { flex: 1 },
    rowUrl: { fontSize: 12, color: c.textPrimary },
    rowStatus: { fontSize: 11, marginTop: 4, fontWeight: '500' },
    rowHistory: {
      fontSize: 10,
      color: c.textHint,
      marginTop: 2,
      fontStyle: 'italic',
    },
    /** 「以前下载过、后来被彻底删除」的提示（墓碑表命中）。 */
    rowDeleted: {
      fontSize: 10,
      color: c.danger,
      marginTop: 2,
    },
    skipHintRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: c.surfaceStrong,
      borderRadius: 6,
      marginTop: 6,
    },
    skipHintText: {
      flex: 1,
      fontSize: 11,
      color: c.textSecondary,
      marginRight: 8,
    },
    smallBtn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 4,
      backgroundColor: c.primary,
    },
    smallBtnText: { color: c.textOnPrimary, fontSize: 11, fontWeight: '600' },
    progress: { fontSize: 12, color: c.textSecondary, marginTop: 8 },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingTop: 8,
      paddingBottom: 16,
    },
    actionBtn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 6,
      backgroundColor: c.surfaceStrong,
    },
    actionBtnPrimary: { backgroundColor: c.primary },
    actionBtnDanger: { backgroundColor: '#c62828' },
    actionBtnText: { color: c.textPrimary, fontWeight: '600', fontSize: 13 },
    /** 「清除」放在开始旁边，用警示色但保留普通按钮底，避免太扎眼。 */
    actionBtnTextDanger: { color: c.danger },
    spinner: { alignItems: 'center', paddingVertical: 12 },
    dismiss: {
      alignSelf: 'center',
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    dismissText: { color: c.textSecondary, fontSize: 12 },

    /* ---------------- 在线图集（everia 列表页） ---------------- */
    onlineSafe: { flex: 1, backgroundColor: c.background },
    onlineHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    onlineTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    onlineClose: { fontSize: 24, color: c.textSecondary, lineHeight: 26 },
    onlineHint: {
      fontSize: 12,
      color: c.textSecondary,
      paddingHorizontal: 16,
      paddingTop: 10,
    },
    onlinePages: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    pageChip: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceStrong,
      borderWidth: 1,
      borderColor: c.border,
    },
    pageChipOn: { backgroundColor: c.primary, borderColor: c.primary },
    pageChipText: { fontSize: 14, color: c.textPrimary, fontWeight: '600' },
    pageChipTextOn: { color: c.textOnPrimary },
    onlineActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    onlineFetchBtn: {
      flex: 1,
      paddingVertical: 11,
      borderRadius: 8,
      backgroundColor: c.primary,
      alignItems: 'center',
    },
    onlineFetchText: {
      color: c.textOnPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    onlineError: {
      fontSize: 12,
      color: c.danger,
      paddingHorizontal: 16,
      paddingBottom: 4,
    },
    onlineStats: {
      fontSize: 12,
      color: c.textSecondary,
      paddingHorizontal: 16,
      paddingBottom: 6,
    },
    onlineList: { flex: 1 },
    onlineListContent: { paddingHorizontal: 16, paddingBottom: 12 },
    onlineEmpty: {
      textAlign: 'center',
      color: c.textHint,
      fontSize: 13,
      paddingVertical: 40,
    },
    onlineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    onlineCheck: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    onlineCheckOn: { backgroundColor: c.primary, borderColor: c.primary },
    onlineCheckMark: {
      color: c.textOnPrimary,
      fontSize: 13,
      fontWeight: '700',
      lineHeight: 16,
    },
    onlineThumb: {
      width: 46,
      height: 60,
      borderRadius: 4,
      backgroundColor: c.surfaceStrong,
    },
    onlineThumbEmpty: { backgroundColor: c.surfaceStrong },
    /** 缩略图的可点区域：尺寸与图片一致，圆角裁切让按下反馈不外溢。 */
    onlineThumbHit: {
      width: 46,
      height: 60,
      borderRadius: 4,
      overflow: 'hidden',
    },
    /** 预览大图：铺满全屏的黑底，上下滑不动、左右翻相邻候选。 */
    previewRoot: { flex: 1, backgroundColor: '#000' },
    previewBar: {
      paddingHorizontal: 12,
      paddingBottom: 6,
      backgroundColor: 'rgba(0,0,0,0.85)',
    },
    previewBarRow: {
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    previewCounterWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    previewCounter: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
    previewSelectBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.5)',
    },
    previewSelectBtnOn: {
      backgroundColor: '#FFD166',
      borderColor: '#FFD166',
    },
    previewSelectText: {
      fontSize: 13,
      lineHeight: 16,
      color: '#fff',
      fontWeight: '600',
    },
    previewSelectTextOn: { color: '#1a1a1a' },
    previewTitle: {
      color: 'rgba(255,255,255,0.75)',
      fontSize: 11,
      paddingBottom: 4,
    },
    previewPager: { flex: 1 },
    previewPage: {
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
    },
    previewImage: { width: '100%', height: '100%' },
    previewFailed: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
    previewSpinner: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    previewTop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      alignItems: 'flex-end',
      paddingHorizontal: 12,
    },
    previewCloseBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    previewCloseText: { color: '#fff', fontSize: 30, lineHeight: 34 },
    onlineRowTitle: { fontSize: 12, color: c.textPrimary },
    /* ---------- 历史抓取列表 ---------- */
    onlineHistoryWrap: { flex: 1 },
    onlineHistoryBusy: { paddingVertical: 40, alignItems: 'center' },
    onlineSessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    onlineSessionTime: {
      fontSize: 13,
      color: c.textPrimary,
      fontWeight: '600',
    },
    onlineSessionMeta: { fontSize: 11, color: c.textHint, marginTop: 3 },
    onlineSessionChevron: { fontSize: 20, color: c.textHint },
    /** 标题 + 状态提示的竖排容器。 */
    onlineRowText: { flex: 1 },
    /** 以前下载过又被删掉：用警示色提醒。 */
    onlineBadgeWarn: { fontSize: 10, color: c.danger, marginTop: 2 },
    /** 上次抓到了但没勾选：浅色提醒。 */
    onlineBadgeMuted: { fontSize: 10, color: c.textHint, marginTop: 2 },
    onlineFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    onlineCount: { fontSize: 12, color: c.textSecondary },
    onlineAddBtn: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.primary,
    },
    onlineAddText: {
      color: c.textOnPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}
