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
  ToastAndroid,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState } from '../components/EmptyState';
import { ZoomableImage } from '../components/ZoomableImage';
import {
  getSetting,
  importImageFavorites,
  listFavoriteImages,
  setImageFavorite,
  setSetting,
  type FavoriteImage,
} from '../services/historyService';
import { isVideoUri, TelegraphDownloader } from '../services/nativeDownloader';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';
import type { RootStackScreenProps } from '../navigation/types';

type Props = RootStackScreenProps<'FavoriteImages'>;

const COLS = 3;
const GAP = 2;
/** 一次性导入系统相册收藏的完成标记（settings KV）。 */
const IMPORT_FLAG = 'image_favorites_imported_v1';

function tileSizeFor(width: number): number {
  return Math.floor((width - (COLS + 1) * GAP) / COLS);
}

/**
 * 收藏图片：所有在 **App 内**收藏过的图片（跨下载记录）。
 *
 * 和手机相册的收藏夹是两套东西：这里只读本机数据库（`image_favorites` 表），
 * 增删都不会改动系统相册的收藏标记。首次打开时会把老的「系统相册收藏」一次性
 * 导入进来（只导入本 App 保存目录里的图片），避免老用户升级后看到一片空白。
 */
export const FavoriteImagesScreen: React.FC<Props> = ({ navigation }) => {
  // Subscribe so labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const { width } = useWindowDimensions();

  const [items, setItems] = useState<FavoriteImage[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 全屏查看器当前打开的下标；null = 关闭。 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  /** 读库 → 列表。 */
  const load = useCallback(async () => {
    try {
      const rows = await listFavoriteImages();
      setItems(rows);
      setFailed(false);
    } catch {
      setItems([]);
      setFailed(true);
    }
  }, []);

  /**
   * 首次打开：把系统相册里「本 App 目录下」的收藏导入 App 收藏。
   * 标记写在 settings KV 里，失败时不写，下次进入还会再试一次。
   */
  const importOnce = useCallback(async () => {
    try {
      if ((await getSetting(IMPORT_FLAG)) === '1') return;
      setImporting(true);
      let uris: string[] = [];
      if (TelegraphDownloader?.listFavoriteImages) {
        uris = await TelegraphDownloader.listFavoriteImages();
      }
      const added = await importImageFavorites(uris);
      await setSetting(IMPORT_FLAG, '1');
      if (added > 0) {
        ToastAndroid.show(
          t('favoriteImages.imported', { count: added }),
          ToastAndroid.LONG,
        );
      }
    } catch {
      // 导入是锦上添花：失败就当作没有旧收藏，界面照常可用。
    } finally {
      setImporting(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await importOnce();
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [importOnce, load]);

  const size = tileSizeFor(width);
  const tileH = Math.round((size * 4) / 3);

  /** 按 COLS 切行：不用 FlatList 的 numColumns（Fabric 下分组会崩，见详情页注释）。 */
  const gridRows = useMemo(() => {
    const list = items ?? [];
    const out: { index: number; cells: FavoriteImage[] }[] = [];
    for (let i = 0; i < list.length; i += COLS) {
      out.push({ index: i, cells: list.slice(i, i + COLS) });
    }
    return out;
  }, [items]);

  /** 取消收藏：先本地移除（界面立刻响应），再写库。 */
  const removeOne = useCallback(
    (uri: string) => {
      const idx = items ? items.findIndex(item => item.uri === uri) : -1;
      const remaining = items ? items.filter(item => item.uri !== uri) : [];
      setItems(remaining);
      if (idx >= 0 && viewerIndex != null) {
        setViewerIndex(
          remaining.length === 0
            ? null
            : Math.min(viewerIndex, remaining.length - 1),
        );
      }
      setImageFavorite(uri, false).catch(() => undefined);
      ToastAndroid.show(t('favoriteImages.removed'), ToastAndroid.SHORT);
    },
    [items, viewerIndex],
  );

  const confirmRemove = useCallback(
    (uri: string) => {
      Alert.alert(t('favoriteImages.remove'), undefined, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('favoriteImages.remove'), onPress: () => removeOne(uri) },
      ]);
    },
    [removeOne],
  );

  const openViewer = useCallback((index: number) => setViewerIndex(index), []);

  const total = items?.length ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      {items == null || importing ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          {importing ? (
            <Text style={styles.hint}>{t('favoriteImages.importing')}</Text>
          ) : null}
        </View>
      ) : total === 0 ? (
        <View style={styles.center}>
          <EmptyState
            title={failed ? t('favoriteImages.loadFailed') : t('favoriteImages.empty')}
            hint={failed ? undefined : t('favoriteImages.emptyHint')}
          />
        </View>
      ) : (
        <FlatList
          data={gridRows}
          keyExtractor={(_, index) => `row-${index}`}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={5}
          ListHeaderComponent={
            <Text style={styles.count}>
              {t('favoriteImages.count', { count: total })}
            </Text>
          }
          renderItem={({ item: row }) => (
            <View style={styles.gridRow}>
              {row.cells.map((item, k) => (
                <Pressable
                  key={item.uri}
                  onPress={() => openViewer(row.index + k)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={
                    item.title
                      ? decodeHtmlEntities(item.title)
                      : t('favoriteImages.title')
                  }
                  style={({ pressed }) => [
                    styles.tile,
                    { width: size, height: tileH },
                    pressed && styles.pressed,
                  ]}
                >
                  <FavoriteThumb uri={item.uri} fallbackUri={item.url} />
                </Pressable>
              ))}
              {/* 末行不足 3 格时补空位，保证每行宽度一致 */}
              {Array.from({ length: Math.max(0, COLS - row.cells.length) }).map(
                (_, k) => (
                  <View
                    key={`pad-${k}`}
                    style={[styles.tile, { width: size, height: tileH }]}
                  />
                ),
              )}
            </View>
          )}
          contentContainerStyle={styles.list}
        />
      )}

      <FavoriteViewer
        items={items ?? []}
        index={viewerIndex}
        onChangeIndex={setViewerIndex}
        onClose={() => setViewerIndex(null)}
        onRemove={confirmRemove}
        onOpenRecord={recordId => {
          setViewerIndex(null);
          navigation.navigate('HistoryDetail', { id: recordId });
        }}
      />
    </SafeAreaView>
  );
};

/** 网格缩略图：本地打不开时退回远程地址，再不行留空位。 */
const FavoriteThumb: React.FC<{ uri: string; fallbackUri?: string }> = React.memo(
  ({ uri, fallbackUri }) => {
    const styles = useThemedStyles(createStyles);
    const [phase, setPhase] = useState<'local' | 'remote' | 'failed'>('local');
    if (isVideoUri(uri)) {
      return <View style={styles.tileBlank} />;
    }
    if (phase === 'failed') {
      return <View style={styles.tileBlank} />;
    }
    const source = phase === 'remote' && fallbackUri ? fallbackUri : uri;
    return (
      <Image
        source={{ uri: source }}
        style={styles.image}
        resizeMode="cover"
        resizeMethod="resize"
        onError={() => {
          if (phase === 'local' && fallbackUri) setPhase('remote');
          else setPhase('failed');
        }}
      />
    );
  },
);
FavoriteThumb.displayName = 'FavoriteThumb';

/**
 * 收藏图片的全屏查看器：左右滑动翻页，底部显示所属记录，右上可取消收藏。
 * 独立实现（不复用详情页那个）：这里的数据源是跨记录的图片列表，没有封面 /
 * 失败统计这些记录级功能。
 */
const FavoriteViewer: React.FC<{
  items: FavoriteImage[];
  index: number | null;
  onChangeIndex: (index: number) => void;
  onClose: () => void;
  onRemove: (uri: string) => void;
  onOpenRecord: (recordId: number) => void;
}> = ({ items, index, onChangeIndex, onClose, onRemove, onOpenRecord }) => {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const [anchor, setAnchor] = useState(0);
  const visible = index != null && items.length > 0;
  const safeIndex = index == null ? 0 : Math.max(0, Math.min(index, items.length - 1));
  const current = items[safeIndex];

  useEffect(() => {
    if (!visible) return;
    setAnchor(safeIndex);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: safeIndex * width, animated: false });
    });
    // safeIndex 只在「打开 / 外部改变下标」时需要重新定位；滑动时由 onScrollEnd
    // 自己维护 anchor，不在这里回写（否则会来回跳）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, width]);

  const handleScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / width);
      if (idx < 0 || idx >= items.length) return;
      setAnchor(idx);
      if (idx !== index) onChangeIndex(idx);
    },
    [index, items.length, onChangeIndex, width],
  );

  if (!visible || !current) return null;

  return (
    <Modal
      visible
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
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={({ pressed }) => [
              styles.viewerCloseBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.viewerCloseText}>×</Text>
          </Pressable>
          <View pointerEvents="none" style={styles.viewerCounterWrap}>
            <Text style={styles.viewerCounter}>
              {t('preview.viewerIndex', {
                current: safeIndex + 1,
                total: items.length,
              })}
            </Text>
          </View>
          <Pressable
            onPress={() => onRemove(current.uri)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('favoriteImages.remove')}
            style={({ pressed }) => [
              styles.viewerPill,
              styles.viewerPillOn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.viewerPillText, styles.viewerPillTextOn]}>
              {t('favoriteImages.remove')}
            </Text>
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          onScrollEndDrag={handleScrollEnd}
          scrollEventThrottle={32}
          style={styles.viewerScroll}
          contentContainerStyle={styles.viewerScrollContent}
        >
          {items.map((item, i) => (
            <View key={item.uri} style={[styles.viewerPage, { width }]}>
              {Math.abs(i - anchor) <= VIEWER_WINDOW_RADIUS ? (
                // 必须套一层「满宽 + flex:1」的容器：viewerPage 是
                // alignItems:'center'，直接放 ZoomableImage 会让它的宽度塌成 0，
                // 结果整页全黑（图片其实已经加载好了）。详情页的查看器同样
                // 依赖 viewerPageInner 这一层。
                <View style={styles.viewerPageInner}>
                  <ViewerImage
                    uri={item.uri}
                    fallbackUri={item.url || undefined}
                  />
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>

        <View style={styles.viewerFooter}>
          <Text style={styles.viewerTitle} numberOfLines={1}>
            {current.title
              ? decodeHtmlEntities(current.title)
              : t('favoriteImages.unknownRecord')}
          </Text>
          {current.recordId > 0 ? (
            <Pressable
              onPress={() => onOpenRecord(current.recordId)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.footerBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.footerBtnText}>
                {t('favoriteImages.openRecord')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
};

/** 挂载窗口半径（同详情页查看器：只保留当前页 ±1，避免几十张原图同时解码）。 */
const VIEWER_WINDOW_RADIUS = 2;

/**
 * 查看器里的一张图：本地文件打不开时先用记录的远程地址再试一次
 * （老记录存在 WebP 存成 .jpg、或文件已被手动删除的情况）。
 */
const ViewerImage: React.FC<{ uri: string; fallbackUri?: string }> = ({
  uri,
  fallbackUri,
}) => {
  const styles = useThemedStyles(createStyles);
  const [phase, setPhase] = useState<'local' | 'remote' | 'failed'>('local');
  const [retryKey, setRetryKey] = useState(0);

  if (phase === 'failed') {
    return (
      <View style={styles.viewerError}>
        <Text style={styles.viewerErrorText}>
          {t('preview.imageLoadFailed')}
        </Text>
        <Pressable
          onPress={() => {
            setPhase('local');
            setRetryKey(k => k + 1);
          }}
          style={({ pressed }) => [
            styles.footerBtn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.footerBtnText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ZoomableImage
      key={`${retryKey}-${phase}`}
      uri={phase === 'remote' && fallbackUri ? fallbackUri : uri}
      onError={() => {
        if (phase === 'local' && fallbackUri) setPhase('remote');
        else setPhase('failed');
      }}
    />
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    hint: { marginTop: 10, fontSize: 12, color: c.textHint },
    list: { paddingBottom: 24 },
    count: {
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 6,
      fontSize: 12,
      color: c.textHint,
    },
    gridRow: { flexDirection: 'row' },
    tile: {
      margin: GAP / 2,
      backgroundColor: c.surfaceStrong,
      overflow: 'hidden',
    },
    tileBlank: { flex: 1, backgroundColor: c.surfaceStrong },
    image: { width: '100%', height: '100%' },
    pressed: { opacity: 0.7 },
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
    /** 页码按剩余空间自适应（绝对定位会和右边的按钮叠在一起）。 */
    viewerCounterWrap: {
      flex: 1,
      alignItems: 'center',
    },
    viewerCounter: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
    viewerPill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.5)',
    },
    viewerPillOn: { backgroundColor: '#FF4D6D', borderColor: '#FF4D6D' },
    viewerPillText: {
      fontSize: 13,
      lineHeight: 16,
      color: '#fff',
      fontWeight: '600',
    },
    viewerPillTextOn: { color: '#fff' },
    viewerScroll: { flex: 1 },
    viewerScrollContent: { alignItems: 'center' },
    viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    /** 给 ZoomableImage 一个满宽容器（见渲染处的注释：不然宽度会塌成 0）。 */
    viewerPageInner: { flex: 1, width: '100%' },
    viewerError: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    viewerErrorText: { color: '#fff', fontSize: 15 },
    viewerFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: 'rgba(0,0,0,0.85)',
    },
    viewerTitle: { flex: 1, color: '#fff', fontSize: 13 },
    footerBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.5)',
    },
    footerBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  });
}
