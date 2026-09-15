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
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';
import type { RootStackParamList } from '../navigation/types';
import {
  isDownloaderAvailable,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import { parseArticle } from '../services/telegraphParser';
import { useDownload } from '../store/DownloadContext';
import { listHistoryByUrls } from '../services/historyService';
import { dedupeUrls } from '../utils/batchScheduler';
import type { BatchItem, BatchItemStatus } from '../types/batch';

/**
 * Batch URL-download flow:
 *   1. Tap "选择 url.txt" → native SAF picker → content split into lines.
 *   2. Tap "开始" → scheduler iterates URLs serially:
 *      parseArticle(url) → on success call `downloadContext.runDownload(article)` →
 *      advance to next URL.
 *   3. Per-URL failures are skipped; pause/resume/skip/cancel affect the loop.
 */
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
  /** URL whose row is currently parsing for a preview (spinner + press lock). */
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);

  const batchAbortRef = useRef<AbortController | null>(null);
  const pauseResumeRef = useRef<{
    paused: boolean;
    resumeWaiter: (() => void) | null;
  }>({ paused: false, resumeWaiter: null });

  // Reset on unmount so leaving the screen fully cancels any in-flight batch.
  useEffect(
    () => () => {
      batchAbortRef.current?.abort();
      if (pauseResumeRef.current.resumeWaiter) {
        pauseResumeRef.current.resumeWaiter();
      }
    },
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

  // Sync the row whose index matches `index` with a status patcher. Accepts
  // either a partial patch (Partial<BatchItem>) or a function of the
  // previous row (same ergonomics as React's setState).
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

  const runBatch = useCallback(async () => {
    if (running || items.length === 0) return;
    if (batchAbortRef.current) return;
    setRunning(true);
    setPaused(false);
    setShowSummary(false);
    batchAbortRef.current = new AbortController();
    const signal = batchAbortRef.current.signal;
    let done = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (signal.aborted) break;
      if (items[i]?.status === 'skipped') {
        skipped += 1;
        continue;
      }
      await waitIfPaused();
      if (signal.aborted) break;

      updateItem(i, { status: 'parsing', detail: '', progress: null });

      let result;
      try {
        result = await parseArticle(items[i].url, { signal });
      } catch {
        updateItem(i, { status: 'failed', detail: '解析异常' });
        failed += 1;
        continue;
      }
      if (!result.ok || !result.article || result.article.images.length === 0) {
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
          summary.failed > 0 && summary.success === 0 && summary.skipped === 0;
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
        updateItem(i, { status: 'failed', detail: '下载失败', progress: null });
        failed += 1;
      }
    }
    batchAbortRef.current = null;
    setRunning(false);
    setPaused(false);
    setShowSummary(true);
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
    runBatch().catch(() => undefined);
  }, [runBatch]);

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
      const isReQueueable = !!item.existing || item.status === 'skipped';
      const isPreviewing = previewingUrl === item.url;
      return (
        <Pressable
          onPress={() => openPreview(item, index)}
          onLongPress={
            isReQueueable && !running ? () => requeueItem(index) : undefined
          }
          disabled={isPreviewing}
          style={({ pressed }) => [
            styles.row,
            styles.rowPressable,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.rowMain}>
            <Text style={[styles.rowUrl]} numberOfLines={1}>
              {index + 1}. {item.url}
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
    ],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.body}>
        <Text style={styles.intro}>{t('batch.intro')}</Text>
        {items.length === 0 ? (
          <Pressable
            onPress={handlePickFile}
            style={({ pressed }) => [styles.pickBtn, pressed && styles.pressed]}
          >
            <Text style={styles.pickBtnText}>{t('batch.pickFile')}</Text>
          </Pressable>
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
    </SafeAreaView>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    body: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
    intro: { fontSize: 13, color: c.textSecondary, marginBottom: 12 },
    pickBtn: {
      backgroundColor: c.primary,
      paddingVertical: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    pickBtnText: { color: c.textOnPrimary, fontWeight: '600', fontSize: 15 },
    pressed: { opacity: 0.6 },
    fileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    fileLabel: { flex: 1, fontSize: 13, color: c.textPrimary, marginRight: 8 },
    repickBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: c.surfaceStrong,
    },
    repickBtnText: { color: c.textPrimary, fontSize: 12, fontWeight: '500' },
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
    rowMain: { flex: 1 },
    rowUrl: { fontSize: 12, color: c.textPrimary },
    rowStatus: { fontSize: 11, marginTop: 4, fontWeight: '500' },
    rowHistory: {
      fontSize: 10,
      color: c.textHint,
      marginTop: 2,
      fontStyle: 'italic',
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
    spinner: { alignItems: 'center', paddingVertical: 12 },
    dismiss: {
      alignSelf: 'center',
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    dismissText: { color: c.textSecondary, fontSize: 12 },
  });
}
