import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { EmptyState } from '../components/EmptyState';
import {
  countHistory,
  initHistoryDatabase,
  listDailyCounts,
  listHistory,
  type HistoryListFilter,
  type HistoryRecord,
  type HistoryStatus,
} from '../services/historyService';
import type { MainTabScreenProps } from '../navigation/types';
import { t, useI18n } from '../i18n';
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

  // Search / filter state. Both are applied server-side (in SQL) so the
  // pagination math stays correct even when hundreds/thousands of rows exist.
  const [query, setQuery] = useState('');
  const [filterDay, setFilterDay] = useState<Date | null>(null);
  // Download-status filter (enum). null = 全部 / no status predicate.
  const [filterStatus, setFilterStatus] = useState<HistoryStatus | null>(null);

  // Calendar filter modal (custom month grid showing per-day counts).
  const [showCalendar, setShowCalendar] = useState(false);
  // Status filter sheet (enum picker).
  const [showStatusPicker, setShowStatusPicker] = useState(false);

  const listRef = useRef<SectionList<HistoryRecord, Section> | null>(null);

  // Keep the latest filter values in refs so the memoised `reload` never
  // closes over a stale query/date.
  const queryRef = useRef(query);
  queryRef.current = query;
  const filterDayRef = useRef(filterDay);
  filterDayRef.current = filterDay;
  const filterStatusRef = useRef(filterStatus);
  filterStatusRef.current = filterStatus;

  const buildFilter = useCallback((): HistoryListFilter | undefined => {
    const title = queryRef.current.trim();
    const day = filterDayRef.current;
    const status = filterStatusRef.current;
    const filter: HistoryListFilter = {};
    if (title) filter.title = title;
    if (day) {
      const dayStart = startOfLocalDay(day.getTime());
      filter.createdAfterMs = dayStart;
      filter.createdBeforeMs = dayStart + DAY_MS;
    }
    if (status) filter.status = status;
    return filter.title || filter.createdAfterMs != null || filter.status
      ? filter
      : undefined;
  }, []);

  const reload = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setLoadError(false);
      const filter = buildFilter();
      try {
        await initHistoryDatabase();
        const [rows, totalRows] = await Promise.all([
          listHistory(PAGE_SIZE, nextOffset, filter),
          countHistory(filter),
        ]);
        setRecords(rows);
        setOffset(nextOffset);
        setTotal(totalRows);
        setHasMoreInDb(totalRows > nextOffset + rows.length);
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
    if (loading || loadingMore) return;
    if (!hasMoreInDb) return;
    if (records.length >= PAGE_BATCH) return; // page is full → pagination buttons take over
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

  const gotoPrevPage = useCallback(() => {
    const prev = Math.max(0, offset - PAGE_BATCH);
    reload(prev);
  }, [offset, reload]);

  const gotoNextPage = useCallback(() => {
    if (!hasMoreInDb) return;
    reload(offset + PAGE_BATCH);
  }, [offset, hasMoreInDb, reload]);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToLocation({
      sectionIndex: 0,
      itemIndex: 0,
      viewPosition: 0,
      animated: true,
    });
  }, []);

  const sections = useMemo<Section[]>(
    () => groupByLocalDate(records),
    [records],
  );

  // Ordered ids of the currently loaded records, handed to the detail screen so
  // it can swipe between neighbours without re-querying.
  const recordIds = useMemo(() => records.map(r => r.id), [records]);

  const showFab = records.length > PAGE_SIZE;
  const showPagination = records.length >= PAGE_BATCH || offset > 0;
  const hasFilter =
    query.trim().length > 0 || filterDay != null || filterStatus != null;

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
      if (consumeHistoryChanged()) reload(0);
    }, [reload]),
  );

  const pageFrom = offset + 1;
  const pageTo = offset + records.length;
  const showPrevPage = offset > 0;
  const showNextPage = hasMoreInDb;
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

      {/* Active filter chips (date and/or status) */}
      {filterDay || filterStatus ? (
        <View style={styles.chipRow}>
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
          <Pressable
            onPress={gotoPrevPage}
            disabled={!showPrevPage}
            hitSlop={8}
            style={({ pressed }) => [
              styles.pageBtn,
              !showPrevPage && styles.pageBtnDisabled,
              pressed && showPrevPage && styles.pressed,
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
            disabled={!showNextPage}
            hitSlop={8}
            style={({ pressed }) => [
              styles.pageBtn,
              !showNextPage && styles.pageBtnDisabled,
              pressed && showNextPage && styles.pressed,
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
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowMain}>
        {/* Full title, wrapping over as many lines as needed (no truncation). */}
        <Text style={styles.rowTitle}>{record.title}</Text>
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

function formatLocalTime(utcMs: number): string {
  const d = new Date(utcMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
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
    rowMain: { flex: 1, paddingRight: 12 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: c.textPrimary },
    rowMeta: { marginTop: 3, fontSize: 12, color: c.textHint },
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
