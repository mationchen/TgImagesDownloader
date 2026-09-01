import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {EmptyState} from '../components/EmptyState';
import {
  initHistoryDatabase,
  listHistory,
  removeHistory,
  type HistoryRecord,
} from '../services/historyService';
import {parseTelegraphArticle} from '../services/telegraphParser';
import type {RootStackScreenProps} from '../navigation/types';
import {t} from '../i18n';

type Props = RootStackScreenProps<'History'>;

interface Section {
  title: string;
  data: HistoryRecord[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const HistoryScreen: React.FC<Props> = ({navigation}) => {
  const [records, setRecords] = useState<HistoryRecord[] | null>(null);

  const load = useCallback(async () => {
    await initHistoryDatabase();
    const items = await listHistory(500);
    setRecords(items);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo<Section[]>(() => groupByLocalDate(records ?? []), [records]);

  const handleDelete = useCallback(
    (record: HistoryRecord) => {
      Alert.alert(
        t('history.deleteConfirmTitle'),
        t('history.deleteConfirmMsg'),
        [
          {text: t('history.cancel'), style: 'cancel'},
          {
            text: t('history.deleteConfirmOk'),
            style: 'destructive',
            onPress: async () => {
              await removeHistory(record.id);
              setRecords(prev => (prev ?? []).filter(r => r.id !== record.id));
            },
          },
        ],
      );
    },
    [],
  );

  const handleReparse = useCallback(
    async (record: HistoryRecord) => {
      const result = await parseTelegraphArticle(record.url);
      if (result.ok && result.article) {
        navigation.navigate('Preview', {article: result.article});
      } else {
        Alert.alert(t('error.parseError'));
      }
    },
    [navigation],
  );

  const handleLongPress = useCallback(
    (record: HistoryRecord) => {
      Alert.alert(record.title, undefined, [
        {text: t('history.reparse'), onPress: () => handleReparse(record)},
        {
          text: t('history.delete'),
          style: 'destructive',
          onPress: () => handleDelete(record),
        },
        {text: t('history.cancel'), style: 'cancel'},
      ]);
    },
    [handleDelete, handleReparse],
  );

  if (records === null) {
    return (
      <SafeAreaView style={styles.safe} edges={['left', 'right']}>
        <View style={styles.center}>
          <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      {records.length === 0 ? (
        <EmptyState title={t('history.empty')} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={item => String(item.id)}
          stickySectionHeadersEnabled
          renderSectionHeader={({section}) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          renderItem={({item}) => (
            <HistoryRow record={item} onLongPress={() => handleLongPress(item)} />
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
};

const HistoryRow: React.FC<{record: HistoryRecord; onLongPress: () => void}> = React.memo(
  ({record, onLongPress}) => {
    return (
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({pressed}) => [styles.row, pressed && styles.pressed]}>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {record.title}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {t('history.itemCount', {count: record.imageCount})} · {formatLocalTime(record.createdAt)}
          </Text>
        </View>
        <View style={styles.rowBadge}>
          <Text style={styles.rowBadgeText}>{record.status}</Text>
        </View>
      </Pressable>
    );
  },
);
HistoryRow.displayName = 'HistoryRow';

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
  return keys.map(key => ({title: key, data: map.get(key)!}));
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
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
    local.getDate(),
  ).padStart(2, '0')}`;
}

function formatLocalTime(utcMs: number): string {
  const d = new Date(utcMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
    2,
    '0',
  )}`;
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  loadingText: {color: '#888', fontSize: 13},
  list: {paddingBottom: 24},
  sectionHeader: {
    backgroundColor: '#f2f4f6',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#555',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  pressed: {backgroundColor: '#f6f8fa'},
  rowMain: {flex: 1, paddingRight: 12},
  rowTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111',
  },
  rowMeta: {
    marginTop: 3,
    fontSize: 12,
    color: '#888',
  },
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
});