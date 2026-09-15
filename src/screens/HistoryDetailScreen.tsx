import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles, type ThemeColors } from '../theme';
import { getHistory, type HistoryRecord } from '../services/historyService';
import {
  isDownloaderAvailable,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import { EmptyState } from '../components/EmptyState';
import { ZoomableImage } from '../components/ZoomableImage';
import type { RootStackScreenProps } from '../navigation/types';
import { isSharedSaveFolder } from '../utils/saveDir';
import { t, useI18n } from '../i18n';

type Props = RootStackScreenProps<'HistoryDetail'>;

const COLS = 3;
const GAP = 2;

function tileSize(): number {
  return Math.floor((Dimensions.get('window').width - (COLS + 1) * GAP) / COLS);
}

export const HistoryDetailScreen: React.FC<Props> = ({ route }) => {
  const { id } = route.params;
  // Subscribe so header/meta strings re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const [record, setRecord] = useState<HistoryRecord | null | 'loading'>(
    'loading',
  );
  // URIs used when the row has no recorded image_paths (older rows / skipped
  // re-runs): either that article's own folder, or its source image URLs.
  const [fallbackUris, setFallbackUris] = useState<string[]>([]);
  // Index of the image tapped in the grid; null = fullscreen viewer closed.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getHistory(id);
      if (cancelled) return;
      setRecord(r);
      if (!r || (r.imagePaths ?? []).length > 0) return;

      if (isSharedSaveFolder(r.saveDir)) {
        // The app defaults to ONE shared folder for every article, so listing
        // it would surface other records' images (the "same batch" bug). Fall
        // back to the record's own source URLs instead.
        if (!cancelled) setFallbackUris(r.imageUrls ?? []);
        return;
      }
      // Per-article subfolder: it holds only this record's files.
      if (isDownloaderAvailable() && TelegraphDownloader?.listGalleryImages) {
        try {
          const uris = await TelegraphDownloader.listGalleryImages(r.saveDir);
          if (!cancelled) setFallbackUris(uris);
        } catch {
          // best-effort; leave the grid empty if the query fails
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onThumbPress = useCallback((idx: number) => {
    setViewerIndex(idx);
  }, []);
  const closeViewer = useCallback(() => setViewerIndex(null), []);

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
    record.imagePaths.length > 0 ? record.imagePaths : fallbackUris;
  const urisEmpty = imageUris.length === 0;
  const size = tileSize();

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <FlatList
        data={imageUris}
        keyExtractor={(uri, idx) => `${idx}-${uri}`}
        numColumns={COLS}
        renderItem={({ item, index }) => (
          <DetailThumb
            uri={item}
            size={size}
            onPress={() => onThumbPress(index)}
          />
        )}
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

      <ImageViewer
        visible={viewerIndex !== null}
        uris={imageUris}
        initialIndex={viewerIndex ?? 0}
        onClose={closeViewer}
      />
    </SafeAreaView>
  );
};

const Header: React.FC<{ record: HistoryRecord }> = React.memo(({ record }) => {
  // Subscribe so meta labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
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

const MetaChip: React.FC<{ label: string }> = React.memo(({ label }) => {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
});
MetaChip.displayName = 'MetaChip';

const DetailThumb: React.FC<{
  uri: string;
  size: number;
  onPress: () => void;
}> = React.memo(({ uri, size, onPress }) => {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { width: size, height: size },
        pressed && styles.tilePressed,
      ]}
    >
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
    </Pressable>
  );
});
DetailThumb.displayName = 'DetailThumb';

/**
 * Minimal paged viewer for content:// URIs recovered from MediaStore.
 * Lighter than the main ViewerModal (which is wired for TelegraphImage and
 * per-image error/probe state).
 */
const ImageViewer: React.FC<{
  visible: boolean;
  uris: string[];
  initialIndex: number;
  onClose: () => void;
}> = ({ visible, uris, initialIndex, onClose }) => {
  // The viewer chrome stays black in both themes; the subscription only
  // forces fresh counter/error strings on locale change.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  // True while the current page is zoomed in; disables page swiping so the
  // image can be dragged without flipping pages.
  const [zoomed, setZoomed] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setZoomed(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          x: initialIndex * width,
          animated: false,
        });
      });
    }
  }, [visible, initialIndex, width]);

  // Reset zoom whenever the visible page changes (only reachable while at 1x).
  useEffect(() => {
    setZoomed(false);
  }, [currentIndex]);

  const handleScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / width);
      if (idx !== currentIndex && idx >= 0 && idx < uris.length) {
        setCurrentIndex(idx);
      }
    },
    [currentIndex, uris.length, width],
  );

  if (!visible || uris.length === 0) return null;

  const safeIndex = Math.max(0, Math.min(currentIndex, uris.length - 1));

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.viewerRoot} edges={['top', 'bottom']}>
        <View style={styles.viewerHeader}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={({ pressed }) => [
              styles.viewerCloseBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.viewerCloseText}>×</Text>
          </Pressable>
          <Text style={styles.viewerCounter}>
            {t('preview.viewerIndex', {
              current: safeIndex + 1,
              total: uris.length,
            })}
          </Text>
          <View style={styles.viewerPlaceholder} />
        </View>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          scrollEventThrottle={16}
          style={styles.viewerScroll}
          contentContainerStyle={styles.viewerScrollContent}
        >
          {uris.map((uri, index) => (
            <View key={uri} style={[styles.viewerPage, { width }]}>
              <ImageViewerPage
                uri={uri}
                onZoomChange={index === safeIndex ? setZoomed : undefined}
              />
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const ImageViewerPage: React.FC<{
  uri: string;
  onZoomChange?: (zoomed: boolean) => void;
}> = ({ uri, onZoomChange }) => {
  // Subscribe so retry/error strings track the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  return (
    <View style={styles.viewerPageInner}>
      {failed ? (
        <View style={styles.viewerErrorBox}>
          <Text style={styles.errorText}>{t('preview.imageLoadFailed')}</Text>
          <Pressable
            onPress={() => {
              setFailed(false);
              setRetryKey(k => k + 1);
              onZoomChange?.(false);
            }}
            style={({ pressed }) => [
              styles.retryBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <ZoomableImage
          key={retryKey}
          uri={uri}
          onZoomChange={onZoomChange}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  );
};

function formatLocal(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: c.textHint, fontSize: 13 },
    list: { paddingBottom: 24 },
    header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    url: { marginTop: 6, fontSize: 12, color: c.primary },
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
      backgroundColor: c.surfaceStrong,
    },
    chipText: { fontSize: 11, color: c.textSecondary },
    saveDir: { marginTop: 10, fontSize: 11, color: c.textHint },
    emptyBlock: {
      alignItems: 'center',
      paddingVertical: 48,
      paddingHorizontal: 16,
    },
    emptyText: { fontSize: 14, color: c.textSecondary },
    emptyHint: {
      marginTop: 6,
      fontSize: 12,
      color: c.textHint,
      textAlign: 'center',
    },
    tile: {
      margin: GAP / 2,
      backgroundColor: c.surfaceStrong,
      overflow: 'hidden',
    },
    image: { width: '100%', height: '100%' },
    tilePressed: {
      opacity: 0.7,
    },
    tileFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.dangerBg,
    },
    tileFallbackText: { fontSize: 22, color: c.danger, fontWeight: '700' },
    viewerRoot: { flex: 1, backgroundColor: '#000' },
    viewerHeader: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 8,
      backgroundColor: 'rgba(0,0,0,0.85)',
    },
    viewerCloseBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    viewerCloseText: {
      color: '#fff',
      fontSize: 28,
      lineHeight: 28,
      fontWeight: '300',
    },
    viewerCounter: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
    viewerPlaceholder: { width: 40 },
    viewerScroll: { flex: 1 },
    viewerScrollContent: { alignItems: 'center' },
    viewerPage: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    viewerPageInner: { flex: 1, width: '100%' },
    viewerImage: { width: '100%', height: '100%' },
    viewerErrorBox: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    errorText: {
      color: '#fff',
      fontSize: 15,
      marginBottom: 12,
      textAlign: 'center',
    },
    retryBtn: {
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: '#fff',
    },
    retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    pressed: { opacity: 0.7 },
  });
}
