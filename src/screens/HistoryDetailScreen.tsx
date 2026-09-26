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
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles, useTheme, type ThemeColors } from '../theme';
import { getHistory, type HistoryRecord } from '../services/historyService';
import {
  isDownloaderAvailable,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import { EmptyState } from '../components/EmptyState';
import { ZoomableImage } from '../components/ZoomableImage';
import type { RootStackScreenProps } from '../navigation/types';
import { isSharedSaveFolder } from '../utils/saveDir';
import {
  HISTORY_STATUS_LABEL_KEY,
  historyStatusVisual,
} from '../utils/historyStatus';
import { confirmDeleteRecord, reparseRecord } from '../utils/historyRowActions';
import { useMediaReadPermission } from '../utils/mediaPermission';
import { t, useI18n } from '../i18n';

type Props = RootStackScreenProps<'HistoryDetail'>;

const COLS = 3;
const GAP = 2;

/** Width of one grid tile for a page that is {@code width} px wide. */
function tileSizeFor(width: number): number {
  return Math.floor((width - (COLS + 1) * GAP) / COLS);
}

/**
 * Copy a record's URL to the clipboard.
 *
 * Android 13+ shows the system's own "copied" confirmation, so the extra toast
 * is only shown on older Android; iOS copies silently (no equivalent toast).
 */
function copyUrl(url: string): void {
  try {
    Clipboard.setString(url);
  } catch {
    return;
  }
  if (Platform.OS === 'android' && Platform.Version < 33) {
    ToastAndroid.show(t('history.link.copied'), ToastAndroid.SHORT);
  }
}

/**
 * 下载记录详情，横向分页：左右滑动可切换到上一条 / 下一条记录。
 *
 * The surrounding ordered id list is passed in `route.params.ids` by the
 * History list; callers that only know a single id (e.g. the Home
 * duplicate-link alert) omit it and get a single, non-swipeable page.
 */
export const HistoryDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { id, ids } = route.params;
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // Records imported from another install of the app reference images owned
  // by that install; reading them needs a media permission (Android). The
  // tick increments once the permission arrives so failed tiles can retry.
  const mediaTick = useMediaReadPermission();

  // Ordered ids for the pager. Always contains the record we were opened with,
  // even if the caller's list doesn't (e.g. it was created after the list load).
  const pageIds = useMemo(() => {
    const list = (ids ?? []).filter(n => Number.isFinite(n));
    return list.includes(id) ? list : [id, ...list];
  }, [ids, id]);

  const initialIndex = Math.max(0, pageIds.indexOf(id));

  // The title-bar actions act on whichever record the pager currently shows, so
  // the index has to be tracked here (each RecordPage owns its own data load).
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [currentRecord, setCurrentRecord] = useState<HistoryRecord | null>(
    null,
  );
  // Spinner while the article is being re-parsed: it fetches every page of the
  // gallery, which can take a while on multi-page posts.
  const [reparsing, setReparsing] = useState(false);

  const currentId = pageIds[currentIndex] ?? id;

  useEffect(() => {
    let cancelled = false;
    getHistory(currentId)
      .then(record => {
        if (!cancelled) setCurrentRecord(record);
      })
      .catch(() => {
        if (!cancelled) setCurrentRecord(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  const onReparse = useCallback(async () => {
    if (!currentRecord || reparsing) return;
    setReparsing(true);
    try {
      const article = await reparseRecord(currentRecord);
      if (article) navigation.navigate('Preview', { article });
    } finally {
      setReparsing(false);
    }
  }, [currentRecord, reparsing, navigation]);

  const onDelete = useCallback(() => {
    if (!currentRecord) return;
    confirmDeleteRecord(currentRecord, {
      onReparsed: () => undefined,
      // The record no longer exists: go back to the list, which reloads via the
      // shared "history changed" flag.
      onDeleted: () => navigation.goBack(),
    });
  }, [currentRecord, navigation]);

  // Re-parse / delete live in the navigation title bar.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        currentRecord ? (
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => {
                onReparse().catch(() => undefined);
              }}
              disabled={reparsing}
              accessibilityRole="button"
              accessibilityLabel={t('history.reparseHint')}
              hitSlop={6}
              style={({ pressed }) => [
                styles.headerActionBtn,
                pressed && styles.pressed,
              ]}
            >
              {reparsing ? (
                <ActivityIndicator size="small" color={colors.headerTitle} />
              ) : (
                <Text style={styles.headerActionText}>🔄</Text>
              )}
            </Pressable>
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel={t('history.delete')}
              hitSlop={6}
              style={({ pressed }) => [
                styles.headerActionBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.headerActionText}>🗑</Text>
            </Pressable>
          </View>
        ) : null,
    });
  }, [
    navigation,
    currentRecord,
    reparsing,
    onReparse,
    onDelete,
    styles,
    colors.headerTitle,
  ]);

  const onPagerScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / width);
      setCurrentIndex(Math.max(0, Math.min(pageIds.length - 1, index)));
    },
    [width, pageIds.length],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <FlatList
        style={styles.pager}
        data={pageIds}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={initialIndex}
        onMomentumScrollEnd={onPagerScrollEnd}
        getItemLayout={(_, index) => ({
          length: width,
          offset: width * index,
          index,
        })}
        keyExtractor={pageId => String(pageId)}
        extraData={width}
        renderItem={({ item }) => (
          <RecordPage id={item} width={width} mediaTick={mediaTick} />
        )}
      />
    </SafeAreaView>
  );
};

/**
 * A single page of the detail pager: one history record rendered as a header
 * plus a 3-column image grid. Each page owns its own data load, so swiping to a
 * neighbour only fetches that record.
 */
const RecordPage: React.FC<{
  id: number;
  width: number;
  mediaTick: number;
}> = React.memo(({ id, width, mediaTick }) => {
  // Subscribe so this page re-renders in the active language.
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
    setRecord('loading');
    setFallbackUris([]);
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
      <View style={{ width }}>
        <View style={styles.center}>
          <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
      </View>
    );
  }

  if (!record) {
    return (
      <View style={{ width }}>
        <EmptyState title={t('history.detail.notFound')} />
      </View>
    );
  }

  const imageUris =
    record.imagePaths.length > 0 ? record.imagePaths : fallbackUris;
  // Remote URLs stay index-aligned with image_paths, so a local URI that
  // cannot be opened can retry once against its own source URL.
  const remoteUrls = record.imageUrls ?? [];
  const urisEmpty = imageUris.length === 0;
  const size = tileSizeFor(width);

  return (
    <View style={{ width }}>
      <FlatList
        style={styles.pageScroll}
        data={imageUris}
        // mediaTick in the key: when the media permission is granted after
        // first render, every tile remounts and retries its image instead
        // of keeping the stale red ×.
        keyExtractor={(uri, idx) => `${mediaTick}-${idx}-${uri}`}
        numColumns={COLS}
        renderItem={({ item, index }) => (
          <DetailThumb
            uri={item}
            size={size}
            fallbackUri={
              item.startsWith('content://') ? remoteUrls[index] : undefined
            }
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
    </View>
  );
});
RecordPage.displayName = 'RecordPage';

const Header: React.FC<{ record: HistoryRecord }> = React.memo(({ record }) => {
  // Subscribe so meta labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  // Tapping the link opens a chooser instead of jumping straight to the
  // browser: the URL is long and often only needed for copying/sharing.
  const onUrlPress = useCallback(() => {
    Alert.alert(t('history.link.title'), record.url, [
      { text: t('history.link.copy'), onPress: () => copyUrl(record.url) },
      {
        text: t('history.link.open'),
        onPress: () => Linking.openURL(record.url).catch(() => undefined),
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [record.url]);

  return (
    <View style={styles.header}>
      {/* Full title: wraps over as many lines as the text needs. */}
      <Text style={styles.title}>{record.title}</Text>
      <Pressable onPress={onUrlPress} hitSlop={6}>
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
        <MetaChip
          label={`${historyStatusVisual(record.status).icon} ${t(
            HISTORY_STATUS_LABEL_KEY[record.status],
          )}`}
        />
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
  /** Optional remote URL to retry with when a local URI fails to open. */
  fallbackUri?: string;
}> = React.memo(({ uri, size, onPress, fallbackUri }) => {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  // When a recorded local content:// URI cannot be opened (e.g. the file was
  // written by an uninstalled build and is not readable), retry once with the
  // record's remote URL so the tile is still useful online.
  const [usingFallback, setUsingFallback] = useState(false);
  const source = failed && fallbackUri && !usingFallback ? fallbackUri : uri;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { width: size, height: size },
        pressed && styles.tilePressed,
      ]}
    >
      {failed && (!fallbackUri || usingFallback) ? (
        <View style={styles.tileFallback}>
          <Text style={styles.tileFallbackText}>×</Text>
        </View>
      ) : (
        <Image
          source={{ uri: source }}
          style={styles.image}
          resizeMode="cover"
          onError={() => {
            if (failed && fallbackUri && !usingFallback) {
              // The fallback also failed: show the placeholder.
              setUsingFallback(true);
            }
            setFailed(true);
          }}
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
    // Horizontal pager: flex so each page stretches to the viewport height.
    pager: { flex: 1 },
    // Inner (vertical) grid inside one page.
    pageScroll: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: c.textHint, fontSize: 13 },
    list: { paddingBottom: 24 },
    header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    /**
     * Navigation title-bar action icons (re-parse / delete). Transparent so
     * they sit cleanly on the coloured header background.
     */
    headerActions: { flexDirection: 'row', alignItems: 'center' },
    headerActionBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerActionText: { fontSize: 17 },
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
