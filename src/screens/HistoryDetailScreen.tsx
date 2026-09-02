import React, { useCallback, useEffect, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getHistory, type HistoryRecord } from '../services/historyService';
import {
  isDownloaderAvailable,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import { EmptyState } from '../components/EmptyState';
import type { RootStackScreenProps } from '../navigation/types';
import { t } from '../i18n';

type Props = RootStackScreenProps<'HistoryDetail'>;

const COLS = 3;
const GAP = 2;

function tileSize(): number {
  return Math.floor((Dimensions.get('window').width - (COLS + 1) * GAP) / COLS);
}

export const HistoryDetailScreen: React.FC<Props> = ({ route }) => {
  const { id } = route.params;
  const [record, setRecord] = useState<HistoryRecord | null | 'loading'>(
    'loading',
  );
  // MediaStore content URIs for the record's save folder, used when the row
  // has no recorded image_paths (older rows / skipped re-runs).
  const [folderUris, setFolderUris] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getHistory(id);
      if (!cancelled) {
        setRecord(r);
        // Fallback: if the row never recorded per-image URIs, read them from
        // MediaStore by matching the save folder. Image files live on disk, so
        // the thumbnails can still be shown.
        if (r && (r.imagePaths ?? []).length === 0) {
          const prefix = r.saveDir || `Pictures/TelegraphDownloader/`;
          if (
            isDownloaderAvailable() &&
            TelegraphDownloader?.listGalleryImages
          ) {
            try {
              const uris = await TelegraphDownloader.listGalleryImages(prefix);
              if (!cancelled) setFolderUris(uris);
            } catch {
              // best-effort; leave the grid empty if the query fails
            }
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (record === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['left', 'right']}>
        <View style={styles.center}>
          <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!record) {
    return (
      <SafeAreaView style={styles.safe} edges={['left', 'right']}>
        <EmptyState title={t('history.detail.notFound')} />
      </SafeAreaView>
    );
  }

  const imageUris =
    record.imagePaths.length > 0 ? record.imagePaths : folderUris;
  const urisEmpty = imageUris.length === 0;
  const size = tileSize();

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <FlatList
        data={imageUris}
        keyExtractor={(uri, idx) => `${idx}-${uri}`}
        numColumns={COLS}
        renderItem={({ item }) => <DetailThumb uri={item} size={size} />}
        ListHeaderComponent={<Header record={record} />}
        ListEmptyComponent={
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyText}>{t('history.detail.noDetail')}</Text>
            <Text style={styles.emptyHint}>
              {t('history.detail.noDetailHint')}
            </Text>
          </View>
        }
        contentContainerStyle={styles.list}
        // Keep an empty list renderable so ListEmptyComponent still fires.
        extraData={urisEmpty ? undefined : imageUris}
      />
    </SafeAreaView>
  );
};

const Header: React.FC<{ record: HistoryRecord }> = React.memo(({ record }) => {
  const openUrl = useCallback(() => {
    Linking.openURL(record.url).catch(() => undefined);
  }, [record.url]);

  return (
    <View style={styles.header}>
      <Text style={styles.title} numberOfLines={2}>
        {record.title}
      </Text>
      <Pressable onPress={openUrl} hitSlop={6}>
        <Text style={styles.url} numberOfLines={2}>
          {record.url}
        </Text>
      </Pressable>
      <View style={styles.metaRow}>
        <MetaChip
          label={t('history.detail.time', {
            time: formatLocal(record.createdAt),
          })}
        />
        <MetaChip
          label={t('history.detail.imageCount', { count: record.imageCount })}
        />
        <MetaChip
          label={t('history.detail.success', { count: record.successCount })}
        />
        <MetaChip
          label={t('history.detail.failed', { count: record.failedCount })}
        />
        <MetaChip label={record.status} />
      </View>
      <Text style={styles.saveDir}>{record.saveDir}</Text>
      <View style={{ height: GAP }} />
    </View>
  );
});
Header.displayName = 'Header';

const MetaChip: React.FC<{ label: string }> = React.memo(({ label }) => (
  <View style={styles.chip}>
    <Text style={styles.chipText} numberOfLines={1}>
      {label}
    </Text>
  </View>
));
MetaChip.displayName = 'MetaChip';

const DetailThumb: React.FC<{ uri: string; size: number }> = React.memo(
  ({ uri, size }) => {
    const [failed, setFailed] = useState(false);
    return (
      <View style={[styles.tile, { width: size, height: size }]}>
        {failed ? (
          <View style={styles.tileFallback}>
            <Text style={styles.tileFallbackText}>×</Text>
          </View>
        ) : (
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="cover"
            onError={() => setFailed(true)}
          />
        )}
      </View>
    );
  },
);
DetailThumb.displayName = 'DetailThumb';

function formatLocal(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#888', fontSize: 13 },
  list: { paddingBottom: 24 },
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#111' },
  url: { marginTop: 6, fontSize: 12, color: '#1976d2' },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 6,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#eef2f5',
  },
  chipText: { fontSize: 11, color: '#444' },
  saveDir: { marginTop: 10, fontSize: 11, color: '#888' },
  emptyBlock: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 16,
  },
  emptyText: { fontSize: 14, color: '#555' },
  emptyHint: { marginTop: 6, fontSize: 12, color: '#888', textAlign: 'center' },
  tile: {
    margin: GAP / 2,
    backgroundColor: '#ececec',
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  tileFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fde0e0',
  },
  tileFallbackText: { fontSize: 22, color: '#c33', fontWeight: '700' },
});
