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
  Image,
  Modal,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { EmptyState } from '../components/EmptyState';
import {
  countHistory,
  countMarkedDeleted,
  countTrash,
  initHistoryDatabase,
  listDailyCounts,
  listHistory,
  moveMarkedToTrash,
  TRASH_CAPACITY,
  type HistoryListFilter,
  type HistoryRecord,
  type HistoryStatus,
} from '../services/historyService';
import type { MainTabScreenProps } from '../navigation/types';
import { t, useI18n } from '../i18n';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { formatLocalTime } from '../utils/time';
import { isVideoUri } from '../services/nativeDownloader';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';
import {
  HISTORY_STATUS_LABEL_KEY,
  historyStatusVisual,
  type HistoryStatusTone,
} from '../utils/historyStatus';
import {
  consumeHistoryChanged,
  showHistoryRowActions,
} from '../utils/historyRowActions';
import {
  clampPageOffset,
  hasNextPage as computeHasNextPage,
} from '../utils/pagination';
import { consumeLastViewedHistory } from '../utils/lastViewed';
import type { HistoryEdgeInfo } from '../navigation/types';

type Props = MainTabScreenProps<'History'>;

interface Section {
  title: string;
  data: HistoryRecord[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Order of the download-status enum in the filter sheet. Matches the badge
 * vocabulary used on every row: ✓ 完成 / ! 部分失败 / ✕ 失败 / – 已取消.
 */
const STATUS_ORDER: HistoryStatus[] = [
  'done',
  'partial',
  'failed',
  'cancelled',
];

/* Pagination knobs — see AGENTS.md §4 / §history rules. */
const PAGE_SIZE = 20; // records loaded per scroll/pull
const PAGE_BATCH = 100; // records per "page" (5 batches) — pagination buttons appear once a page is full

export const HistoryScreen: React.FC<Props> = ({ navigation }) => {
  // Subscribe so sections/headers re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors: themeColors } = useTheme();
  // Records currently loaded (the visible page).
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  // Offset (in the underlying history rows) of the first record in `records`.
  const [offset, setOffset] = useState(0);
  // Total number of rows in the history table (for pagination math).
  const [total, setTotal] = useState(0);
  // True when there are more rows past the current visible window in the DB.
  const [hasMoreInDb, setHasMoreInDb] = useState(false);
  // True while a load is in flight (initial load / load-more / page change).
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  /** Pull-to-refresh spinner (kept separate from the initial-load spinner). */
  const [refreshing, setRefreshing] = useState(false);

  // Search / filter state. Both are applied server-side (in SQL) so the
  // pagination math stays correct even when hundreds/thousands of rows exist.
  const [query, setQuery] = useState('');
  const [filterDay, setFilterDay] = useState<Date | null>(null);
  // Download-status filter (enum). null = 全部 / no status predicate.
  const [filterStatus, setFilterStatus] = useState<HistoryStatus | null>(null);
  /** 只看收藏。 */
  const [filterFavorite, setFilterFavorite] = useState(false);
  /** 「标记为删除」且未进回收站的条数（决定「移入回收站」按钮显示）。 */
  const [markedCount, setMarkedCount] = useState(0);

  // Calendar filter modal (custom month grid showing per-day counts).
  const [showCalendar, setShowCalendar] = useState(false);
  // Status filter sheet (enum picker).
  const [showStatusPicker, setShowStatusPicker] = useState(false);

  const listRef = useRef<SectionList<HistoryRecord, Section> | null>(null);
  /** onEndReached 的并发闸门（state 更新是异步的，光靠 loadingMore 拦不住同帧连发）。 */
  const loadMoreBusyRef = useRef(false);

  // Keep the latest filter values in refs so the memoised `reload` never
  // closes over a stale query/date.
  const queryRef = useRef(query);
  queryRef.current = query;
  const filterDayRef = useRef(filterDay);
  filterDayRef.current = filterDay;
  const filterStatusRef = useRef(filterStatus);
  filterStatusRef.current = filterStatus;
  const filterFavoriteRef = useRef(filterFavorite);
  filterFavoriteRef.current = filterFavorite;

  const buildFilter = useCallback((): HistoryListFilter | undefined => {
    const title = queryRef.current.trim();
    const day = filterDayRef.current;
    const status = filterStatusRef.current;
    const favoriteOnly = filterFavoriteRef.current;
    const filter: HistoryListFilter = {};
    if (title) filter.title = title;
    if (day) {
      const dayStart = startOfLocalDay(day.getTime());
      filter.createdAfterMs = dayStart;
      filter.createdBeforeMs = dayStart + DAY_MS;
    }
    if (status) filter.status = status;
    if (favoriteOnly) filter.favoriteOnly = true;
    return filter.title ||
      filter.createdAfterMs != null ||
      filter.status ||
      filter.favoriteOnly
      ? filter
      : undefined;
  }, []);

  const reload = useCallback(
    async (
      nextOffset: number,
      opts?: { silent?: boolean; limit?: number },
    ) => {
      // `silent` keeps the current list on screen (pull-to-refresh) instead of
      // swapping it for the full-screen spinner.
      if (!opts?.silent) setLoading(true);
      setLoadError(false);
      const filter = buildFilter();
      try {
        await initHistoryDatabase();
        // 先取总数再算偏移：记录变少（删除 / 移入回收站）后当前页可能已越界，
        // 这时落到最后一页，而不是给用户一个空白页。
        const totalRows = await countHistory(filter);
        // 越界时按**整页**对齐回落，避免出现 `881-889` 这种和翻页按钮对不上的区间。
        const safeOffset = clampPageOffset(nextOffset, totalRows, PAGE_BATCH);
        // 取多少条由调用方决定：翻页 / 刷新取满一整页（页码区间立刻稳定），
        // 首屏与滚动追加仍按 PAGE_SIZE 分批，避免一次渲染过多行。
        const limit = Math.max(1, Math.floor(opts?.limit ?? PAGE_SIZE));
        const [rows, marked] = await Promise.all([
          listHistory(limit, safeOffset, filter),
          countMarkedDeleted(),
        ]);
        setRecords(rows);
        setOffset(safeOffset);
        setTotal(totalRows);
        setMarkedCount(marked);
        setHasMoreInDb(totalRows > safeOffset + rows.length);
      } catch {
        setLoadError(true);
        setRecords([]);
        setOffset(nextOffset);
        setHasMoreInDb(false);
      } finally {
        setLoading(false);
      }
    },
    [buildFilter],
  );

  /** 当前页偏移的镜像：刷新回调里读最新值，避免闭包拿到过期页码。 */
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  /** 当前已加载条数的镜像：刷新时按「原来显示多少条」重新取，页码区间才不会缩水。 */
  const loadedCountRef = useRef(records.length);
  loadedCountRef.current = records.length;

  /**
   * 重新加载**用户当前所在的那一页**。
   * 下拉刷新、从详情页返回都用它 —— 页码不该被重置回第一页，
   * 展示的区间也不该从 `101-200` 缩成 `101-120`。
   */
  const refreshCurrentPage = useCallback(
    (opts?: { silent?: boolean }) =>
      reload(offsetRef.current, {
        ...opts,
        limit: Math.max(PAGE_SIZE, loadedCountRef.current),
      }),
    [reload],
  );

  /** 一键把「标记为删除」的记录移入回收站（确认后执行）。 */
  const onMoveToTrash = useCallback(() => {
    if (markedCount <= 0) return;
    // 先看回收站还剩多少名额：满了就直接拦下，别让用户点完确认才发现没进去。
    (async () => {
      let trashed = 0;
      try {
        trashed = await countTrash();
      } catch {
        return;
      }
      if (trashed >= TRASH_CAPACITY) {
        Alert.alert(
          t('trash.fullTitle'),
          t('trash.fullMsg', { capacity: TRASH_CAPACITY }),
        );
        return;
      }
      const room = TRASH_CAPACITY - trashed;
      Alert.alert(
        t('history.moveToTrashTitle'),
        room >= markedCount
          ? t('history.moveToTrashMsg', { count: markedCount })
          : t('history.moveToTrashMsgPartial', { count: markedCount, room }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('history.moveToTrash'),
            style: 'destructive',
            onPress: () => {
              moveMarkedToTrash()
                .then(async res => {
                  if (res.moved > 0) {
                    ToastAndroid.show(
                      t('history.moveToTrashDone', { count: res.moved }),
                      ToastAndroid.SHORT,
                    );
                  }
                  if (res.skipped > 0) {
                    ToastAndroid.show(
                      t('trash.fullMsg', { capacity: TRASH_CAPACITY }),
                      ToastAndroid.LONG,
                    );
                  }
                  await refreshCurrentPage({ silent: true });
                })
                .catch(() => undefined);
            },
          },
        ],
      );
    })();
  }, [markedCount, refreshCurrentPage]);

  // Pull-to-refresh: 刷新当前页（不回到第一页，列表也不闪）。
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshCurrentPage({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }, [refreshCurrentPage]);

  // Initial load. Also re-runs immediately when the date / status filter changes.
  useEffect(() => {
    reload(0);
  }, [filterDay, filterStatus, reload]);

  // Debounced reload for the free-text title search.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return; // handled by the effect above (empty = off)
    const timer = setTimeout(() => reload(0), 300);
    return () => clearTimeout(timer);
  }, [query, reload]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || loadMoreBusyRef.current) return;
    if (!hasMoreInDb) return;
    if (records.length >= PAGE_BATCH) return; // page is full → pagination buttons take over
    // onEndReached 可能在同一个帧里连续触发（内容不足一屏时尤其明显），
    // 用 ref 兜住并发：否则会追加重复的行、重复 key 会让列表上下闪。
    loadMoreBusyRef.current = true;
    setLoadingMore(true);
    setLoadError(false);
    const filter = buildFilter();
    try {
      const moreOffset = offset + records.length;
      const rows = await listHistory(PAGE_SIZE, moreOffset, filter);
      setRecords(prev => [...prev, ...rows]);
      setHasMoreInDb(total > moreOffset + rows.length);
    } catch {
      setLoadError(true);
    } finally {
      loadMoreBusyRef.current = false;
      setLoadingMore(false);
    }
  }, [
    loading,
    loadingMore,
    hasMoreInDb,
    records.length,
    offset,
    total,
    buildFilter,
  ]);

  /**
   * 滚回列表顶部（翻页 / 回到顶部按钮共用）。
   *
   * 用底层 ScrollView 的 `scrollTo` 而不是 `scrollToLocation`：后者在目标行
   * 未渲染、又没有 `getItemLayout` 时会静默失效 —— 翻页时列表正停在底部，
   * 第一行十有八九没渲染出来。
   */
  const scrollListToTop = useCallback((animated: boolean) => {
    try {
      listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated });
    } catch {
      // 列表尚未完成布局时可能抛错，忽略即可。
    }
  }, []);

  /**
   * 翻页前先把旧页滚回顶部。
   * 否则切页后列表会停在「旧滚动位置被夹到新页底部」的状态，
   * 立刻满足 onEndReached，导致新页连续追加数据（就是第二页上下闪的根因）。
   */
  const gotoPrevPage = useCallback(() => {
    // 已经在第一页：按钮看起来是灰的，但仍然点得动 —— 给一句提示，
    // 免得用户以为是按钮坏了。
    if (offset <= 0) {
      ToastAndroid.show(t('history.firstPage'), ToastAndroid.SHORT);
      return;
    }
    const prev = Math.max(0, offset - PAGE_BATCH);
    scrollListToTop(false);
    reload(prev, { limit: PAGE_BATCH });
  }, [offset, reload, scrollListToTop]);

  const gotoNextPage = useCallback(() => {
    if (!computeHasNextPage(offset, total, PAGE_BATCH)) {
      ToastAndroid.show(t('history.lastPage'), ToastAndroid.SHORT);
      return;
    }
    scrollListToTop(false);
    reload(offset + PAGE_BATCH, { limit: PAGE_BATCH });
  }, [offset, total, reload, scrollListToTop]);

  const scrollToTop = useCallback(() => {
    scrollListToTop(true);
  }, [scrollListToTop]);

  const sections = useMemo<Section[]>(
    () => groupByLocalDate(records),
    [records],
  );
  /** 最新分组数据的镜像：focus 回调里定位「上次查看的记录」时用。 */
  const sectionsRef = useRef<Section[]>(sections);
  sectionsRef.current = sections;

  /** 详情页返回时要定位的记录 id（scrollToIndexFailed 后重试用）。 */
  const pendingScrollIdRef = useRef<number | null>(null);

  /**
   * 把列表滚到指定记录。
   * 目标常常在当前渲染窗口之外（用户可能滑了几十条），
   * `scrollToLocation` 失败时由 {@link onScrollToIndexFailed} 估算位置后重试。
   */
  const scrollToRecordId = useCallback((recordId: number) => {
    const list = listRef.current;
    const groups = sectionsRef.current;
    if (!list) return;
    for (let si = 0; si < groups.length; si += 1) {
      const ii = groups[si].data.findIndex(r => r.id === recordId);
      if (ii >= 0) {
        pendingScrollIdRef.current = recordId;
        try {
          list.scrollToLocation({
            sectionIndex: si,
            itemIndex: ii,
            viewPosition: 0,
            animated: false,
          });
        } catch {
          // 交给 onScrollToIndexFailed 兜底
        }
        return;
      }
    }
  }, []);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const list = listRef.current;
      if (!list) return;
      // 先按平均行高跳到大致位置，等目标进入渲染窗口后再精确定位。
      list
        .getScrollResponder()
        ?.scrollTo({
          y: Math.max(0, info.averageItemLength * info.index),
          animated: false,
        });
      const id = pendingScrollIdRef.current;
      if (id == null) return;
      setTimeout(() => {
        const groups = sectionsRef.current;
        const current = listRef.current;
        if (!current) return;
        for (let si = 0; si < groups.length; si += 1) {
          const ii = groups[si].data.findIndex(r => r.id === id);
          if (ii >= 0) {
            try {
              current.scrollToLocation({
                sectionIndex: si,
                itemIndex: ii,
                viewPosition: 0,
                animated: false,
              });
            } catch {
              // 仍然失败就保持大致位置
            }
            break;
          }
        }
      }, 160);
    },
    [],
  );

  // Ordered ids of the currently loaded records, handed to the detail screen so
  // it can swipe between neighbours without re-querying.
  const recordIds = useMemo(() => records.map(r => r.id), [records]);

  const showFab = records.length > PAGE_SIZE;
  const showPagination = records.length >= PAGE_BATCH || offset > 0;
  const hasFilter =
    query.trim().length > 0 ||
    filterDay != null ||
    filterStatus != null ||
    filterFavorite;

  const openDatePicker = useCallback(() => {
    setShowCalendar(true);
  }, []);

  const onCalendarSelect = useCallback((date: Date) => {
    setFilterDay(date);
    setShowCalendar(false);
  }, []);

  /** Apply (or clear, with null) the download-status filter. */
  const onStatusSelect = useCallback((status: HistoryStatus | null) => {
    setFilterStatus(status);
    setShowStatusPicker(false);
  }, []);

  const clearFilter = useCallback(() => {
    setQuery('');
    setFilterDay(null);
    setFilterStatus(null);
    setFilterFavorite(false);
  }, []);

  const handleLongPress = useCallback(
    (record: HistoryRecord) => {
      showHistoryRowActions(record, {
        onReparsed: article => navigation.navigate('Preview', { article }),
        onDeleted: deleted => {
          setRecords(prev => prev.filter(r => r.id !== deleted.id));
          setTotal(prev => Math.max(0, prev - 1));
        },
      });
    },
    [navigation],
  );

  // Reload when another screen changed history rows (e.g. a delete from the
  // detail page). Guarded by the shared flag so ordinary tab switches keep the
  // current page/scroll position instead of jumping back to page 1.
  useFocusEffect(
    useCallback(() => {
      // 有变化时只刷新**当前页**：看完详情返回不该把人甩回第一页。
      if (consumeHistoryChanged()) refreshCurrentPage({ silent: true });
      // 又从详情页滑了几十条？回到列表直接停在最后看的那一条。
      const lastViewed = consumeLastViewedHistory();
      if (lastViewed == null) return undefined;
      // 等返回动画结束、列表完成布局再定位：立刻滚的话目标还没测量出来，
      // scrollToLocation 会静默落空。
      const timer = setTimeout(() => {
        scrollToRecordId(lastViewed);
      }, 350);
      return () => clearTimeout(timer);
    }, [refreshCurrentPage, scrollToRecordId]),
  );

  const pageFrom = offset + 1;
  // 已加载条数不会超过总数，但仍夹一次，避免删除并发时出现 `1-100 / 共 89`。
  const pageTo = Math.min(offset + records.length, total);
  const showPrevPage = offset > 0;
  // 下一页的**起点**必须还在总数内才可点：`801-889` 这种最后的不完整页要禁用，
  // 否则会点出 `881-889`，再回退又变成 `781-800` 这种对不上的区间。
  const showNextPage = computeHasNextPage(offset, total, PAGE_BATCH);
  /** 详情页滑到本页第一条/最后一条时，用这些信息告诉用户下一步怎么做。 */
  const detailEdges = useMemo<HistoryEdgeInfo>(
    () => ({
      hasPrevPage: offset > 0,
      hasNextPage: computeHasNextPage(offset, total, PAGE_BATCH),
      canLoadMore: hasMoreInDb && records.length < PAGE_BATCH,
    }),
    [offset, total, hasMoreInDb, records.length],
  );
  const filterDateLabel = filterDay
    ? t('history.filterDateSelected', {
        date: formatDay(filterDay),
      })
    : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={t('history.searchPlaceholder')}
            placeholderTextColor={themeColors.textHint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel={t('history.searchClearA11y')}
              hitSlop={8}
              style={styles.searchClear}
            >
              <Text style={styles.searchClearText}>×</Text>
            </Pressable>
          ) : null}
        </View>
        {/* Download-status filter: icon button that opens the enum picker. */}
        <Pressable
          onPress={() => setShowStatusPicker(true)}
          accessibilityRole="button"
          accessibilityLabel={t('history.filterByStatus')}
          style={({ pressed }) => [
            styles.statusBtn,
            filterStatus && styles.dateBtnActive,
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[
              styles.dateBtnText,
              filterStatus && styles.dateBtnTextActive,
            ]}
          >
            {filterStatus ? historyStatusVisual(filterStatus).icon : '🏷'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setFilterFavorite(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={t('history.favoriteOnly')}
          style={({ pressed }) => [
            styles.statusBtn,
            filterFavorite && styles.dateBtnActive,
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[
              styles.dateBtnText,
              filterFavorite && styles.dateBtnTextActive,
            ]}
          >
            ★
          </Text>
        </Pressable>
        <Pressable
          onPress={openDatePicker}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.dateBtn,
            filterDay && styles.dateBtnActive,
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[styles.dateBtnText, filterDay && styles.dateBtnTextActive]}
          >
            📅 {t('history.filterByDate')}
          </Text>
        </Pressable>
      </View>

      {/* 一键把「标记为删除」的记录移入回收站 */}
      {markedCount > 0 ? (
        <View style={styles.trashRow}>
          <Pressable
            onPress={onMoveToTrash}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.trashBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.trashBtnText}>
              🗑 {t('history.moveToTrashCount', { count: markedCount })}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Active filter chips (date / status / favorites) */}
      {filterDay || filterStatus || filterFavorite ? (
        <View style={styles.chipRow}>
          {filterFavorite ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>★ {t('history.favoriteOnly')}</Text>
              <Pressable onPress={() => setFilterFavorite(false)} hitSlop={10}>
                <Text style={styles.chipClear}>×</Text>
              </Pressable>
            </View>
          ) : null}
          {filterDay ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>{filterDateLabel}</Text>
              <Pressable onPress={() => setFilterDay(null)} hitSlop={10}>
                <Text style={styles.chipClear}>×</Text>
              </Pressable>
            </View>
          ) : null}
          {filterStatus ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>
                {historyStatusVisual(filterStatus).icon}{' '}
                {t(HISTORY_STATUS_LABEL_KEY[filterStatus])}
              </Text>
              <Pressable onPress={() => setFilterStatus(null)} hitSlop={10}>
                <Text style={styles.chipClear}>×</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            onPress={clearFilter}
            hitSlop={8}
            style={styles.clearAllBtn}
          >
            <Text style={styles.clearAllText}>{t('history.clearFilter')}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Pagination bar (appears after a page is fully loaded) */}
      {showPagination ? (
        <View style={styles.pageBar}>
          {/* 边界时按钮只是变灰，**不禁用** —— 点一下会 Toast 说明原因。 */}
          <Pressable
            onPress={gotoPrevPage}
            hitSlop={8}
            style={({ pressed }) => [
              styles.pageBtn,
              !showPrevPage && styles.pageBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.pageBtnText,
                !showPrevPage && styles.pageBtnTextDisabled,
              ]}
            >
              ‹ {t('history.prevPage')}
            </Text>
          </Pressable>
          <Text style={styles.pageIndicator}>
            {t('history.pageIndicator', { from: pageFrom, to: pageTo, total })}
          </Text>
          <Pressable
            onPress={gotoNextPage}
            hitSlop={8}
            style={({ pressed }) => [
              styles.pageBtn,
              !showNextPage && styles.pageBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.pageBtnText,
                !showNextPage && styles.pageBtnTextDisabled,
              ]}
            >
              {t('history.nextPage')} ›
            </Text>
          </Pressable>
        </View>
      ) : null}

      {loading && records.length === 0 ? (
        <View style={styles.center}>
          {loadError ? (
            <Text style={styles.loadingText}>{t('history.loadFailed')}</Text>
          ) : (
            <ActivityIndicator color={themeColors.primary} />
          )}
        </View>
      ) : records.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            title={hasFilter ? t('history.noMatch') : t('history.empty')}
          />
        </View>
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={item => String(item.id)}
          stickySectionHeadersEnabled
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          onScrollToIndexFailed={onScrollToIndexFailed}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <HistoryRow
              record={item}
              onPress={() =>
                navigation.navigate('HistoryDetail', {
                  id: item.id,
                  ids: recordIds,
                  edges: detailEdges,
                  baseOffset: offset,
                  total,
                })
              }
              onLongPress={() => handleLongPress(item)}
            />
          )}
          ListFooterComponent={
            <View style={styles.footerWrap}>
              {loadingMore ? (
                <View style={styles.footerStatus}>
                  <ActivityIndicator color={themeColors.primary} />
                  <Text style={styles.footerStatusText}>
                    {t('history.loadingMore')}
                  </Text>
                </View>
              ) : !hasMoreInDb ? (
                <Text style={styles.footerStatusText}>
                  {t('history.endOfList')}
                </Text>
              ) : null}
              {loadError ? (
                <Text style={styles.footerError}>
                  {t('history.loadFailed')}
                </Text>
              ) : null}
            </View>
          }
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                onRefresh().catch(() => undefined);
              }}
              colors={[themeColors.primary]}
              tintColor={themeColors.textSecondary}
            />
          }
        />
      )}

      {showFab ? (
        <Pressable
          onPress={scrollToTop}
          accessibilityRole="button"
          accessibilityLabel={t('history.backToTopA11y')}
          hitSlop={8}
          style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
        >
          <Text style={styles.fabIcon}>↑</Text>
        </Pressable>
      ) : null}

      {/* Date filter calendar */}
      <HistoryCalendar
        visible={showCalendar}
        initialDate={filterDay}
        onSelect={onCalendarSelect}
        onClose={() => setShowCalendar(false)}
      />

      {/* Download-status filter sheet (enum picker) */}
      <HistoryStatusPicker
        visible={showStatusPicker}
        selected={filterStatus}
        onSelect={onStatusSelect}
        onClose={() => setShowStatusPicker(false)}
      />
    </SafeAreaView>
  );
};

const HistoryRow: React.FC<{
  record: HistoryRecord;
  onPress: () => void;
  onLongPress: () => void;
}> = React.memo(({ record, onPress, onLongPress }) => {
  // Subscribe so item labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const visual = historyStatusVisual(record.status);
  const badge = statusBadgeColors(colors, visual.tone);
  const statusLabel = t(HISTORY_STATUS_LABEL_KEY[record.status]);
  // 图集预览：优先本地已存的第一张，本地打不开（老记录 WebP 存成 .jpg、
  // 或文件被删除）时自动换远程 URL 再试一次，两张都失败才显示占位图标。
  const localPreview = record.imagePaths?.[0] ?? null;
  const remotePreview = record.imageUrls?.[0] ?? null;
  const [previewPhase, setPreviewPhase] = useState<'local' | 'remote' | 'failed'>(
    'local',
  );
  const previewUri =
    previewPhase === 'remote' && remotePreview
      ? remotePreview
      : localPreview ?? remotePreview;
  const previewIsVideo = previewUri ? isVideoUri(previewUri) : false;
  const showPreview = !!previewUri && !previewIsVideo && previewPhase !== 'failed';
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {showPreview ? (
        <Image
          source={{ uri: previewUri }}
          style={styles.rowThumb}
          resizeMode="cover"
          onError={() => {
            if (previewPhase === 'local' && remotePreview && localPreview) {
              setPreviewPhase('remote');
            } else {
              setPreviewPhase('failed');
            }
          }}
        />
      ) : (
        <View style={[styles.rowThumb, styles.rowThumbEmpty]}>
          <Text style={styles.rowThumbIcon}>{previewIsVideo ? '🎬' : '🖼'}</Text>
        </View>
      )}
      <View style={styles.rowMain}>
        {/* Full title, wrapping over as many lines as needed (no truncation). */}
        <Text style={styles.rowTitle}>{decodeHtmlEntities(record.title)}</Text>
        {record.isFavorite || record.isMarkedDeleted ? (
          <View style={styles.tagRow}>
            {record.isFavorite ? <Text style={styles.tagFav}>★</Text> : null}
            {record.isMarkedDeleted ? (
              <Text style={styles.tagWarn}>{t('history.markedBadge')}</Text>
            ) : null}
          </View>
        ) : null}
        <Text style={styles.rowMeta} numberOfLines={1}>
          {record.failedCount > 0
            ? t('history.itemCountPartial', {
                success: record.successCount,
                total: record.imageCount,
              })
            : t('history.itemCount', { count: record.imageCount })}{' '}
          · {formatLocalTime(record.createdAt)}
        </Text>
      </View>
      <View
        style={[styles.rowBadge, { backgroundColor: badge.bg }]}
        accessibilityRole="image"
        accessibilityLabel={statusLabel}
      >
        <Text style={[styles.rowBadgeText, { color: badge.color }]}>
          {visual.icon}
        </Text>
      </View>
    </Pressable>
  );
});
HistoryRow.displayName = 'HistoryRow';

/** Map a status tone to its badge foreground + soft background colours. */
function statusBadgeColors(
  c: ThemeColors,
  tone: HistoryStatusTone,
): { color: string; bg: string } {
  switch (tone) {
    case 'success':
      return { color: c.success, bg: c.successBg };
    case 'warning':
      return { color: c.warning, bg: c.warningBg };
    case 'danger':
      return { color: c.danger, bg: c.dangerBg };
    default:
      return { color: c.textHint, bg: c.surfaceStrong };
  }
}

/* ------------------------------------------------------------------ */
/* HistoryCalendar — custom month grid with per-day record counts       */
/* ------------------------------------------------------------------ */

const CAL_ROWS = 6; // fixed 6-week grid so the sheet height is stable
const CAL_CELLS = CAL_ROWS * 7;

function formatDayKey(y: number, m: number, d: number): number {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

/**
 * Month grid calendar shown in a bottom sheet. Each day cell shows the day
 * number and, underneath, how many history records were created that local
 * day (0 -> nothing, dot-free). Uses {listDailyCounts} which aggregates by
 * the user's local day.
 */
/**
 * Download-status filter sheet.
 *
 * Lists every status a history row can hold (plus "全部"), using the same
 * glyph + label vocabulary as the row badges. Selecting an option applies it
 * immediately and closes the sheet; "全部" clears the status predicate.
 */
const HistoryStatusPicker: React.FC<{
  visible: boolean;
  selected: HistoryStatus | null;
  onSelect: (status: HistoryStatus | null) => void;
  onClose: () => void;
}> = ({ visible, selected, onSelect, onClose }) => {
  // Subscribe so option labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  if (!visible) return null;

  const options: { key: HistoryStatus | null; label: string; icon: string }[] =
    [
      { key: null, label: t('history.statusFilter.all'), icon: '≡' },
      ...STATUS_ORDER.map(status => ({
        key: status as HistoryStatus | null,
        label: t(HISTORY_STATUS_LABEL_KEY[status]),
        icon: historyStatusVisual(status).icon,
      })),
    ];

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.calBackdrop} onPress={onClose}>
        <Pressable style={styles.calSheet} onPress={() => undefined}>
          <View style={styles.calHeader}>
            <Text style={styles.statusSheetTitle}>
              {t('history.filterByStatus')}
            </Text>
          </View>
          {options.map(option => {
            const active = option.key === selected;
            return (
              <Pressable
                key={option.key ?? 'all'}
                onPress={() => onSelect(option.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.statusOption,
                  active && styles.statusOptionActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.statusOptionIcon,
                    active && styles.statusOptionTextActive,
                  ]}
                >
                  {option.icon}
                </Text>
                <Text
                  style={[
                    styles.statusOptionText,
                    active && styles.statusOptionTextActive,
                  ]}
                >
                  {option.label}
                </Text>
                {active ? (
                  <Text style={styles.statusOptionCheck}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const HistoryCalendar: React.FC<{
  visible: boolean;
  initialDate: Date | null;
  onSelect: (date: Date) => void;
  onClose: () => void;
}> = ({ visible, initialDate, onSelect, onClose }) => {
  // Subscribe so weekday/month labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [dayCounts, setDayCounts] = useState<Map<number, number>>(new Map());

  // When the sheet opens, jump to the selected month (or today).
  useEffect(() => {
    if (!visible) return;
    const base = initialDate ?? new Date();
    setViewYear(base.getFullYear());
    setViewMonth(base.getMonth());
  }, [visible, initialDate]);

  // Load per-day counts for the currently visible ~6-week window.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setDayCounts(new Map());
    (async () => {
      try {
        await initHistoryDatabase();
        const firstDisplay = new Date(viewYear, viewMonth, 1);
        const offsetWeekday = (firstDisplay.getDay() + 6) % 7; // Monday first
        const firstCell = formatDayKey(viewYear, viewMonth, 1 - offsetWeekday);
        const to = firstCell + CAL_CELLS * DAY_MS;
        const rows = await listDailyCounts(firstCell, to);
        if (cancelled) return;
        const map = new Map<number, number>();
        for (const r of rows) map.set(r.dayStartMs, r.count);
        setDayCounts(map);
      } catch {
        if (!cancelled) setDayCounts(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, viewYear, viewMonth]);

  const changeMonth = useCallback(
    (delta: number) => {
      setViewMonth(prev => {
        if (delta < 0) {
          const d = new Date(viewYear, prev);
          d.setMonth(d.getMonth() - 1);
          setViewYear(d.getFullYear());
          return d.getMonth();
        }
        const maxMonth = new Date().getMonth();
        if (viewYear === new Date().getFullYear() && prev >= maxMonth) {
          return prev; // cannot navigate into the future
        }
        const d = new Date(viewYear, prev + 1);
        setViewYear(d.getFullYear());
        return d.getMonth();
      });
    },
    [viewYear],
  );

  const goToday = useCallback(() => {
    setViewYear(new Date().getFullYear());
    setViewMonth(new Date().getMonth());
  }, []);

  if (!visible) return null;

  const todayStart = startOfLocalDay(Date.now());
  const selectedStart = initialDate
    ? startOfLocalDay(initialDate.getTime())
    : null;

  // Build the 6x7 cell list of {y, m, d, dayStartMs, inMonth}.
  const firstDisplay = new Date(viewYear, viewMonth, 1);
  const offsetWeekday = (firstDisplay.getDay() + 6) % 7; // Monday first
  const cells = Array.from({ length: CAL_CELLS }, (_, i) => {
    const date = new Date(viewYear, viewMonth, 1 - offsetWeekday + i);
    const dayStartMs = formatDayKey(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );
    return {
      y: date.getFullYear(),
      m: date.getMonth(),
      d: date.getDate(),
      dayStartMs,
      inMonth: date.getMonth() === viewMonth,
    };
  });

  const weekdayChars = t('history.calWeekdays').split('');
  const monthTitle = t('history.calMonthFormat', {
    year: viewYear,
    month: viewMonth + 1,
  });

  const rows = [];
  for (let r = 0; r < CAL_ROWS; r += 1) {
    rows.push(cells.slice(r * 7, r * 7 + 7));
  }

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.calBackdrop} onPress={onClose}>
        <Pressable style={styles.calSheet} onPress={() => undefined}>
          {/* Header: prev / month title / next */}
          <View style={styles.calHeader}>
            <Pressable
              onPress={() => changeMonth(-1)}
              accessibilityRole="button"
              accessibilityLabel={t('history.calPrevMonth')}
              hitSlop={10}
              style={styles.calNavBtn}
            >
              <Text style={styles.calNavText}>‹</Text>
            </Pressable>
            <View style={styles.calMonthWrap}>
              <Text style={styles.calMonthTitle}>{monthTitle}</Text>
              <Pressable onPress={goToday} hitSlop={8}>
                <Text style={styles.calGoToday}>{t('history.calGoToday')}</Text>
              </Pressable>
            </View>
            <Pressable
              onPress={() => changeMonth(1)}
              accessibilityRole="button"
              accessibilityLabel={t('history.calNextMonth')}
              hitSlop={10}
              style={styles.calNavBtn}
            >
              <Text style={styles.calNavText}>›</Text>
            </Pressable>
          </View>

          {/* Weekday header row */}
          <View style={styles.calWeekRow}>
            {weekdayChars.map((ch, i) => (
              <Text key={`w${i}`} style={styles.calWeekChar}>
                {ch}
              </Text>
            ))}
          </View>

          {/* Day grid */}
          {rows.map((week, ri) => (
            <View key={`row${ri}`} style={styles.calWeekRow}>
              {week.map(cell => {
                const count = dayCounts.get(cell.dayStartMs) ?? 0;
                const isToday = cell.dayStartMs === todayStart;
                const isSelected = selectedStart === cell.dayStartMs;
                return (
                  <Pressable
                    key={cell.dayStartMs}
                    onPress={() => onSelect(new Date(cell.dayStartMs))}
                    accessibilityRole="button"
                    accessibilityLabel={t('history.calA11yDay', {
                      date: `${cell.y}-${cell.m + 1}-${cell.d}`,
                      count,
                    })}
                    style={[
                      styles.calDayCell,
                      !cell.inMonth && styles.calDayOut,
                      isToday && styles.calDayToday,
                      isSelected && styles.calDaySelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.calDayNum,
                        !cell.inMonth && styles.calDayNumOut,
                        isToday && styles.calDayNumToday,
                        isSelected && styles.calDayNumSelected,
                      ]}
                    >
                      {cell.d}
                    </Text>
                    {count > 0 ? (
                      <View style={styles.calDayCount}>
                        <Text style={styles.calDayCountText}>
                          {t('history.calDayCount', { count })}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* grouping / formatting helpers                                       */
/* ------------------------------------------------------------------ */

function groupByLocalDate(records: HistoryRecord[]): Section[] {
  const map = new Map<string, HistoryRecord[]>();
  for (const r of records) {
    const label = localDateLabel(r.createdAt);
    const arr = map.get(label);
    if (arr) arr.push(r);
    else map.set(label, [r]);
  }
  // Preserve descending date order of keys.
  const keys = Array.from(map.keys());
  return keys.map(key => ({ title: key, data: map.get(key)! }));
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDateLabel(utcMs: number): string {
  const local = new Date(utcMs);
  const now = new Date();
  const todayStart = startOfLocalDay(now.getTime());
  const localStart = startOfLocalDay(local.getTime());
  const diffDays = Math.round((todayStart - localStart) / DAY_MS);
  if (diffDays === 0) return t('history.today');
  if (diffDays === 1) return t('history.yesterday');
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(local.getDate()).padStart(2, '0')}`;
}

function formatDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')}`;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: c.textHint, fontSize: 13 },
    list: { paddingBottom: 96 },
    filterBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
      backgroundColor: c.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    searchWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      height: 38,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: c.textPrimary,
      paddingVertical: 0,
    },
    searchClear: {
      marginLeft: 4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: c.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchClearText: { color: c.background, fontSize: 14, lineHeight: 16 },
    dateBtn: {
      height: 38,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dateBtnActive: { backgroundColor: c.primarySoft },
    dateBtnText: { fontSize: 13, color: c.textSecondary },
    dateBtnTextActive: { color: c.primarySoftText, fontWeight: '600' },
    // Icon-only download-status filter button (between search and date).
    statusBtn: {
      height: 38,
      width: 38,
      borderRadius: 8,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** Title row of the status filter sheet (reuses the calendar chrome). */
    statusSheetTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      paddingHorizontal: 8,
    },
    statusOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderRadius: 10,
    },
    statusOptionActive: { backgroundColor: c.primarySoft },
    statusOptionIcon: {
      width: 22,
      textAlign: 'center',
      fontSize: 15,
      color: c.textSecondary,
    },
    statusOptionText: { flex: 1, fontSize: 15, color: c.textPrimary },
    statusOptionTextActive: { color: c.primarySoftText, fontWeight: '600' },
    statusOptionCheck: {
      fontSize: 15,
      color: c.primarySoftText,
      fontWeight: '700',
    },
    chipRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 2,
      gap: 8,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.primarySoft,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    chipText: { fontSize: 12, color: c.primarySoftText, marginRight: 4 },
    chipClear: { fontSize: 14, color: c.primarySoftText, lineHeight: 16 },
    clearAllBtn: { paddingVertical: 2, paddingHorizontal: 4 },
    clearAllText: { fontSize: 12, color: c.primary },
    pageBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.background,
    },
    pageBtn: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: c.primarySoft,
      minWidth: 92,
      alignItems: 'center',
    },
    pageBtnDisabled: { backgroundColor: c.surface },
    pageBtnText: { color: c.primary, fontSize: 13, fontWeight: '600' },
    pageBtnTextDisabled: { color: c.textHint },
    pageIndicator: {
      color: c.textSecondary,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    sectionHeader: {
      backgroundColor: c.surface,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    sectionTitle: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.background,
    },
    pressed: { backgroundColor: c.surface, opacity: 0.85 },
    /** 列表行左侧的图集预览图（取第一张）。 */
    rowThumb: {
      width: 56,
      height: 56,
      borderRadius: 8,
      marginRight: 12,
      backgroundColor: c.surfaceStrong,
    },
    rowThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
    rowThumbIcon: { fontSize: 20 },
    rowMain: { flex: 1, paddingRight: 12 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: c.textPrimary },
    rowMeta: { marginTop: 3, fontSize: 12, color: c.textHint },
    /** 行内状态标签（收藏星标 / 待删除）。 */
    tagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 3,
    },
    tagFav: { fontSize: 13, color: c.primary },
    tagWarn: {
      fontSize: 11,
      color: c.danger,
      backgroundColor: c.dangerBg,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    /** 「移入回收站」按钮所在的整行。 */
    trashRow: {
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    trashBtn: {
      alignSelf: 'flex-start',
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 8,
      backgroundColor: c.dangerBg,
    },
    trashBtnText: { fontSize: 12.5, color: c.danger, fontWeight: '600' },
    rowBadge: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowBadgeText: {
      fontSize: 14,
      fontWeight: '700',
      lineHeight: 18,
    },
    footerWrap: { paddingVertical: 16, alignItems: 'center' },
    footerStatus: { flexDirection: 'row', alignItems: 'center' },
    footerStatusText: { marginLeft: 8, color: c.textHint, fontSize: 12 },
    footerError: { color: c.danger, fontSize: 12, marginTop: 4 },
    fab: {
      position: 'absolute',
      right: 16,
      bottom: 20,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.18,
      shadowRadius: 4,
      elevation: 4,
    },
    fabIcon: {
      color: c.textOnPrimary,
      fontSize: 22,
      fontWeight: '700',
      lineHeight: 24,
    },
    calBackdrop: {
      flex: 1,
      backgroundColor: c.backdrop,
      justifyContent: 'flex-end',
    },
    calSheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingBottom: 24,
      paddingTop: 12,
      paddingHorizontal: 8,
    },
    calHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 8,
      marginBottom: 10,
    },
    calNavBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    calNavText: { fontSize: 22, color: c.primary, lineHeight: 26 },
    calMonthWrap: { alignItems: 'center' },
    calMonthTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    calGoToday: { marginTop: 2, fontSize: 12, color: c.primary },
    calWeekRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    calWeekChar: {
      flex: 1,
      textAlign: 'center',
      fontSize: 11,
      color: c.textHint,
      paddingVertical: 6,
    },
    calDayCell: {
      flex: 1,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingVertical: 6,
      margin: 1,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    calDayOut: { opacity: 0.35 },
    calDayToday: { borderColor: c.primary },
    calDaySelected: { backgroundColor: c.primarySoft, borderColor: c.primary },
    calDayNum: { fontSize: 14, color: c.textPrimary },
    calDayNumOut: { color: c.textHint },
    calDayNumToday: { color: c.primary, fontWeight: '700' },
    calDayNumSelected: { color: c.primarySoftText, fontWeight: '700' },
    calDayCount: {
      marginTop: 2,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 8,
      backgroundColor: c.primarySoft,
    },
    calDayCountText: {
      fontSize: 10,
      color: c.primarySoftText,
      fontWeight: '600',
    },
  });
}
