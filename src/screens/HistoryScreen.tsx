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
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState } from '../components/EmptyState';
import {
  countHistory,
  initHistoryDatabase,
  listDailyCounts,
  listHistory,
  removeHistory,
  type HistoryListFilter,
  type HistoryRecord,
} from '../services/historyService';
import { parseTelegraphArticle } from '../services/telegraphParser';
import type { MainTabScreenProps } from '../navigation/types';
import { t } from '../i18n';

type Props = MainTabScreenProps<'History'>;

interface Section {
  title: string;
  data: HistoryRecord[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/* Pagination knobs — see AGENTS.md §4 / §history rules. */
const PAGE_SIZE = 20; // records loaded per scroll/pull
const PAGE_BATCH = 100; // records per "page" (5 batches) — pagination buttons appear once a page is full

export const HistoryScreen: React.FC<Props> = ({ navigation }) => {
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

  // Calendar filter modal (custom month grid showing per-day counts).
  const [showCalendar, setShowCalendar] = useState(false);

  const listRef = useRef<SectionList<HistoryRecord, Section> | null>(null);

  // Keep the latest filter values in refs so the memoised `reload` never
  // closes over a stale query/date.
  const queryRef = useRef(query);
  queryRef.current = query;
  const filterDayRef = useRef(filterDay);
  filterDayRef.current = filterDay;

  const buildFilter = useCallback((): HistoryListFilter | undefined => {
    const title = queryRef.current.trim();
    const day = filterDayRef.current;
    const filter: HistoryListFilter = {};
    if (title) filter.title = title;
    if (day) {
      const dayStart = startOfLocalDay(day.getTime());
      filter.createdAfterMs = dayStart;
      filter.createdBeforeMs = dayStart + DAY_MS;
    }
    return filter.title || filter.createdAfterMs != null ? filter : undefined;
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

  // Initial load. Also re-runs immediately when the date filter changes.
  useEffect(() => {
    reload(0);
  }, [filterDay, reload]);

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

  const showFab = records.length > PAGE_SIZE;
  const showPagination = records.length >= PAGE_BATCH || offset > 0;
  const hasFilter = query.trim().length > 0 || filterDay != null;

  const openDatePicker = useCallback(() => {
    setShowCalendar(true);
  }, []);

  const onCalendarSelect = useCallback((date: Date) => {
    setFilterDay(date);
    setShowCalendar(false);
  }, []);

  const clearFilter = useCallback(() => {
    setQuery('');
    setFilterDay(null);
  }, []);

  const handleDelete = useCallback((record: HistoryRecord) => {
    Alert.alert(
      t('history.deleteConfirmTitle'),
      t('history.deleteConfirmMsg'),
      [
        { text: t('history.cancel'), style: 'cancel' },
        {
          text: t('history.deleteConfirmOk'),
          style: 'destructive',
          onPress: async () => {
            await removeHistory(record.id);
            setRecords(prev => prev.filter(r => r.id !== record.id));
            setTotal(prev => Math.max(0, prev - 1));
          },
        },
      ],
    );
  }, []);

  const handleReparse = useCallback(
    async (record: HistoryRecord) => {
      const result = await parseTelegraphArticle(record.url);
      if (result.ok && result.article) {
        navigation.navigate('Preview', { article: result.article });
      } else {
        Alert.alert(t('error.parseError'));
      }
    },
    [navigation],
  );

  const handleLongPress = useCallback(
    (record: HistoryRecord) => {
      Alert.alert(record.title, undefined, [
        { text: t('history.reparse'), onPress: () => handleReparse(record) },
        {
          text: t('history.delete'),
          style: 'destructive',
          onPress: () => handleDelete(record),
        },
        { text: t('history.cancel'), style: 'cancel' },
      ]);
    },
    [handleDelete, handleReparse],
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
            placeholderTextColor="#999"
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

      {/* Active date chip */}
      {filterDay ? (
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{filterDateLabel}</Text>
            <Pressable onPress={() => setFilterDay(null)} hitSlop={10}>
              <Text style={styles.chipClear}>×</Text>
            </Pressable>
          </View>
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
            <ActivityIndicator color="#1976d2" />
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
                navigation.navigate('HistoryDetail', { id: item.id })
              }
              onLongPress={() => handleLongPress(item)}
            />
          )}
          ListFooterComponent={
            <View style={styles.footerWrap}>
              {loadingMore ? (
                <View style={styles.footerStatus}>
                  <ActivityIndicator color="#1976d2" />
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
    </SafeAreaView>
  );
};

const HistoryRow: React.FC<{
  record: HistoryRecord;
  onPress: () => void;
  onLongPress: () => void;
}> = React.memo(({ record, onPress, onLongPress }) => {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {record.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {t('history.itemCount', { count: record.imageCount })} ·{' '}
          {formatLocalTime(record.createdAt)}
        </Text>
      </View>
      <View style={styles.rowBadge}>
        <Text style={styles.rowBadgeText}>{record.status}</Text>
      </View>
    </Pressable>
  );
});
HistoryRow.displayName = 'HistoryRow';

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
const HistoryCalendar: React.FC<{
  visible: boolean;
  initialDate: Date | null;
  onSelect: (date: Date) => void;
  onClose: () => void;
}> = ({ visible, initialDate, onSelect, onClose }) => {
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#888', fontSize: 13 },
  list: { paddingBottom: 96 },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f2f4f6',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 38,
  },
  searchInput: { flex: 1, fontSize: 14, color: '#111', paddingVertical: 0 },
  searchClear: {
    marginLeft: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#cfd4da',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearText: { color: '#fff', fontSize: 14, lineHeight: 16 },
  dateBtn: {
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#f2f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateBtnActive: { backgroundColor: '#e3f0fc' },
  dateBtnText: { fontSize: 13, color: '#444' },
  dateBtnTextActive: { color: '#0d5fb8', fontWeight: '600' },
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
    backgroundColor: '#e3f0fc',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12, color: '#0d5fb8', marginRight: 4 },
  chipClear: { fontSize: 14, color: '#0d5fb8', lineHeight: 16 },
  clearAllBtn: { paddingVertical: 2, paddingHorizontal: 4 },
  clearAllText: { fontSize: 12, color: '#1976d2' },
  pageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  pageBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#eef4fb',
    minWidth: 92,
    alignItems: 'center',
  },
  pageBtnDisabled: { backgroundColor: '#f2f4f6' },
  pageBtnText: { color: '#1976d2', fontSize: 13, fontWeight: '600' },
  pageBtnTextDisabled: { color: '#bbb' },
  pageIndicator: { color: '#555', fontSize: 12, fontVariant: ['tabular-nums'] },
  sectionHeader: {
    backgroundColor: '#f2f4f6',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  sectionTitle: { fontSize: 12, fontWeight: '600', color: '#555' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  pressed: { backgroundColor: '#f6f8fa', opacity: 0.85 },
  rowMain: { flex: 1, paddingRight: 12 },
  rowTitle: { fontSize: 15, fontWeight: '500', color: '#111' },
  rowMeta: { marginTop: 3, fontSize: 12, color: '#888' },
  rowBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#e3f0fc',
  },
  rowBadgeText: {
    fontSize: 11,
    color: '#0d5fb8',
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  footerWrap: { paddingVertical: 16, alignItems: 'center' },
  footerStatus: { flexDirection: 'row', alignItems: 'center' },
  footerStatusText: { marginLeft: 8, color: '#888', fontSize: 12 },
  footerError: { color: '#a32', fontSize: 12, marginTop: 4 },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1976d2',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 4,
  },
  fabIcon: { color: '#fff', fontSize: 22, fontWeight: '700', lineHeight: 24 },
  calBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  calSheet: {
    backgroundColor: '#fff',
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
    backgroundColor: '#f2f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  calNavText: { fontSize: 22, color: '#1976d2', lineHeight: 26 },
  calMonthWrap: { alignItems: 'center' },
  calMonthTitle: { fontSize: 16, fontWeight: '600', color: '#111' },
  calGoToday: { marginTop: 2, fontSize: 12, color: '#1976d2' },
  calWeekRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  calWeekChar: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    color: '#888',
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
  calDayToday: { borderColor: '#1976d2' },
  calDaySelected: { backgroundColor: '#e3f0fc', borderColor: '#1976d2' },
  calDayNum: { fontSize: 14, color: '#222' },
  calDayNumOut: { color: '#999' },
  calDayNumToday: { color: '#1976d2', fontWeight: '700' },
  calDayNumSelected: { color: '#0d5fb8', fontWeight: '700' },
  calDayCount: {
    marginTop: 2,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: '#e3f0fc',
  },
  calDayCountText: { fontSize: 10, color: '#0d5fb8', fontWeight: '600' },
});
