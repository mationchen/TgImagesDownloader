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
  Animated,
  FlatList,
  Image,
  Linking,
  Modal,
  PanResponder,
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
import {
  getHistory,
  reorderHistoryImages,
  setHistoryFavorite,
  setHistoryMarkedDeleted,
  type HistoryRecord,
} from '../services/historyService';
import {
  isDownloaderAvailable,
  isVideoUri,
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
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { t, useI18n } from '../i18n';

type Props = RootStackScreenProps<'HistoryDetail'>;

const COLS = 3;
const GAP = 2;

/** 原生 View 实例类型（RN 0.87 通过组件 ref 暴露）。 */
type HostView = React.ComponentRef<typeof View>;

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

/** Hand a video to the system gallery / video player. */
function playExternally(uri: string): void {
  TelegraphDownloader?.openMediaExternally?.(uri, 'video/*').catch(
    () => undefined,
  );
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

  /** 收藏 / 取消收藏：先本地翻转（图标立刻变），再落库。 */
  const onToggleFavorite = useCallback(() => {
    if (!currentRecord) return;
    const next = !currentRecord.isFavorite;
    setCurrentRecord(prev => (prev ? { ...prev, isFavorite: next } : prev));
    setHistoryFavorite(currentRecord.id, next).catch(() => undefined);
  }, [currentRecord]);

  /** 标记删除 / 取消标记：只是打标记，记录仍留在下载记录里。 */
  const onToggleMarked = useCallback(() => {
    if (!currentRecord) return;
    const next = !currentRecord.isMarkedDeleted;
    setCurrentRecord(prev =>
      prev ? { ...prev, isMarkedDeleted: next } : prev,
    );
    setHistoryMarkedDeleted(currentRecord.id, next).catch(() => undefined);
  }, [currentRecord]);

  // Re-parse / delete live in the navigation title bar.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        currentRecord ? (
          <View style={styles.headerActions}>
            <Pressable
              onPress={onToggleFavorite}
              accessibilityRole="button"
              accessibilityLabel={
                currentRecord.isFavorite
                  ? t('history.detail.unfavorite')
                  : t('history.detail.favorite')
              }
              hitSlop={6}
              style={({ pressed }) => [
                styles.headerActionBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.headerActionText,
                  currentRecord.isFavorite && styles.headerActionActive,
                ]}
              >
                {currentRecord.isFavorite ? '★' : '☆'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onToggleMarked}
              accessibilityRole="button"
              accessibilityLabel={
                currentRecord.isMarkedDeleted
                  ? t('history.detail.unmarkDelete')
                  : t('history.detail.markDelete')
              }
              hitSlop={6}
              style={({ pressed }) => [
                styles.headerActionBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.headerActionText,
                  currentRecord.isMarkedDeleted && styles.headerActionWarn,
                ]}
              >
                {currentRecord.isMarkedDeleted ? '\u21A9\uFE0F' : '\u{1F6AB}'}
              </Text>
            </Pressable>
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
    onToggleFavorite,
    onToggleMarked,
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

  /* ---------------- 手动排序（长按拖动） ---------------- */

  /**
   * `order[i]` = 显示位置 i 上放的是「原始数组」的第几张；null = 未拖动过。
   * 拖动时实时改它，松手后写回数据库。
   */
  const [order, setOrder] = useState<number[] | null>(null);
  const orderRef = useRef<number[] | null>(null);
  /** 被拖方块当前所在的显示位置；null = 没在拖。 */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  /** 跟随手指的悬浮预览图。 */
  const [dragUri, setDragUri] = useState<string | null>(null);
  const draggingRef = useRef(false);

  /** 按下的是第几格（长按后据此开始拖动）。 */
  const pressIndexRef = useRef<number | null>(null);
  const pressedIndexRef = useRef<number | null>(null);
  const [pressedIndex, setPressedIndex] = useState<number | null>(null);
  const pressStartRef = useRef(0);
  const movedRef = useRef(false);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PanResponder 建在 useMemo 里，闭包拿不到最新值，统一走 ref。
  const beginDragRef = useRef<(index: number) => void>(() => undefined);
  const pressHandlerRef = useRef<(index: number) => void>(() => undefined);
  const reorderableRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);
  /** 网格 / 本页在屏幕上的原点，用于把手指坐标换算成格子下标。 */
  const gridOriginRef = useRef({ x: 0, y: 0 });
  const pageOriginRef = useRef({ x: 0, y: 0 });
  const tileRefs = useRef<(HostView | null)[]>([]);
  const rootRef = useRef<HostView | null>(null);
  const dragPos = useRef(new Animated.ValueXY()).current;

  const loadedRecord = record !== 'loading' ? record : null;
  const baseUris =
    loadedRecord && (loadedRecord.imagePaths?.length ?? 0) > 0
      ? loadedRecord.imagePaths
      : loadedRecord
      ? fallbackUris
      : [];
  /** 实际渲染顺序（拖动中会变）。 */
  const uris = order ? order.map(i => baseUris[i]) : baseUris;
  const remoteUrls = loadedRecord?.imageUrls ?? [];
  const size = tileSizeFor(width);
  const cell = size + GAP;
  // 只有「顺序来自记录本身」时才允许拖动 —— 否则改了也存不回数据库。
  const reorderable =
    baseUris.length > 1 &&
    (loadedRecord?.imagePaths?.length ?? 0) === baseUris.length;
  reorderableRef.current = reorderable;

  const urisRef = useRef<string[]>([]);
  useEffect(() => {
    urisRef.current = uris;
  }, [uris]);

  /** 把拖动的结果落库，并把本地记录改成新顺序（避免重复应用）。 */
  const persistOrder = useCallback(
    (nextOrder: number[]) => {
      if (!nextOrder.some((v, i) => v !== i)) {
        setOrder(null);
        orderRef.current = null;
        return;
      }
      setRecord(prev =>
        prev && prev !== 'loading'
          ? {
              ...prev,
              imagePaths: nextOrder.map(i => prev.imagePaths[i]),
              imageUrls: nextOrder.map(i => prev.imageUrls[i]),
              savePaths: nextOrder.map(i => prev.savePaths[i]),
            }
          : prev,
      );
      setOrder(null);
      orderRef.current = null;
      reorderHistoryImages(id, nextOrder).catch(() => undefined);
    },
    [id],
  );

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const from = dragIndexRef.current;
    const to = targetRef.current;
    setDragIndex(null);
    setDragTarget(null);
    setDragUri(null);
    dragIndexRef.current = null;
    targetRef.current = null;
    if (from == null || to == null || from === to) return;
    // 松手后才真正重排 + 落库
    const total = urisRef.current.length;
    const current =
      orderRef.current ?? Array.from({ length: total }, (_, i) => i);
    const next = current.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    orderRef.current = null;
    persistOrder(next);
  }, [persistOrder]);

  /** 手指在屏幕上移动时：算出落到哪一格，只更新高亮。
   *  注意：**不能在拖动过程中重排列表** —— 那会把持有手势的格子移走/重挂，响应者
   *  立刻丢失（实测第 2 次 MOVE 后就再也收不到事件，连 release 都没有）。所以这里
   *  只记录目标位置，等松手再一次性重排。 */
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  const targetRef = useRef<number | null>(null);
  /**
   * 排序模式：长按任意图片进入。
   *
   * 为什么需要它：`onShouldBlockNativeResponder` 只在**手势被授予的那一刻**读取，
   * 而那时拖动还没开始，原生 ScrollView 会在移动超过阈值后把手势抢走（实测拖动
   * 只走一步就 terminate）。先进入模式、把列表滚动关掉，之后的新手势从按下起就
   * 受保护，拖动才连贯。
   */
  const [sortMode, setSortMode] = useState(false);
  const sortModeRef = useRef(false);
  sortModeRef.current = sortMode;
  const moveTo = useCallback(
    (x: number, y: number) => {
      const total = urisRef.current.length;
      const from = dragIndexRef.current;
      if (from == null || total === 0) return;
      const origin = gridOriginRef.current;
      const col = Math.floor((x - origin.x) / cell);
      const row = Math.floor((y - origin.y) / cell);
      const to = Math.max(0, Math.min(row * COLS + col, total - 1));
      if (to === targetRef.current) return;
      targetRef.current = to;
      setDragTarget(to);
    },
    [cell],
  );

  /**
   * 触摸由**格子自己**持有：`Pressable` 会把响应者拿在手里，父级即使在捕获阶段
   * 也抢不过来（实测 onPanResponderMove 一次都没触发），所以这里不用 Pressable，
   * 由外层 View 统一处理「点击 / 长按 / 拖动」。
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        // 关键：没进入排序模式时**不要**阻止原生 ScrollView 接管，否则网格滚不动；
        // 进入排序模式后阻止，拖动才不会被滚动抢走。注意这个回调在手势被授予时
        // 求值一次，所以必须在**按下之前**就已经处于排序模式。
        onShouldBlockNativeResponder: () => sortModeRef.current,
        onPanResponderGrant: (_evt, _g) => {
          movedRef.current = false;
          pressStartRef.current = Date.now();
          pressedIndexRef.current = pressIndexRef.current;
          setPressedIndex(pressIndexRef.current);
          clearLongPress();
          const idx = pressIndexRef.current;
          if (idx != null && reorderableRef.current) {
            longPressRef.current = setTimeout(() => {
              longPressRef.current = null;
              if (movedRef.current || draggingRef.current) return;
              // 已在排序模式 → 直接开始拖动；否则先进入排序模式（用户松手后再拖）。
              if (sortModeRef.current) beginDragRef.current(idx);
              else setSortMode(true);
            }, 320);
          }
        },
        onPanResponderMove: (_evt, g) => {
          if (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8) {
            movedRef.current = true;
            clearLongPress();
          }
          if (!draggingRef.current) return;
          dragPos.setValue({
            x: g.moveX - pageOriginRef.current.x - cell / 2,
            y: g.moveY - pageOriginRef.current.y - cell / 2,
          });
          moveTo(g.moveX, g.moveY);
        },
        onPanResponderRelease: () => {
          clearLongPress();
          const idx = pressIndexRef.current;
          setPressedIndex(null);
          if (draggingRef.current) {
            finishDrag();
            return;
          }
          // 没拖动、也没怎么移动 → 当作一次点击
          if (!movedRef.current && Date.now() - pressStartRef.current < 320) {
            const uri = idx == null ? null : urisRef.current[idx];
            if (uri && isVideoUri(uri)) {
              playExternally(uri);
            } else if (idx != null) {
              pressHandlerRef.current(idx);
            }
          }
        },
        onPanResponderTerminate: () => {
          // 被外层滚动抢走（正常滚动）或其它中断：全部复位
          clearLongPress();
          movedRef.current = true;
          setPressedIndex(null);
          finishDrag();
        },
      }),
    [cell, dragPos, finishDrag, moveTo, clearLongPress],
  );

  const beginDrag = useCallback(
    (index: number) => {
      const tile = tileRefs.current[index];
      if (!tile) return;
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      tile.measureInWindow((x: number, y: number) => {
        gridOriginRef.current = { x: x - col * cell, y: y - row * cell };
        rootRef.current?.measureInWindow((px: number) => {
          pageOriginRef.current = { x: px, y: 0 };
        });
        dragIndexRef.current = index;
        orderRef.current =
          orderRef.current ??
          Array.from({ length: urisRef.current.length }, (_, i) => i);
        dragPos.setValue({ x, y });
        draggingRef.current = true;
        setDragIndex(index);
        setDragUri(urisRef.current[index] ?? null);
      });
    },
    [cell, dragPos],
  );
  beginDragRef.current = beginDrag;

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
          const found = await TelegraphDownloader.listGalleryImages(r.saveDir);
          if (!cancelled) setFallbackUris(found);
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
  pressHandlerRef.current = onThumbPress;
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

  const urisEmpty = uris.length === 0;

  return (
    <View style={{ width }} ref={rootRef}>
      {sortMode ? (
        <View style={styles.sortBar}>
          <Text style={styles.sortBarText}>{t('history.detail.sortHint')}</Text>
          <Pressable
            onPress={() => setSortMode(false)}
            hitSlop={8}
            style={({ pressed }) => [
              styles.sortBarBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.sortBarBtnText}>
              {t('history.detail.sortDone')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        style={styles.pageScroll}
        data={uris}
        // mediaTick in the key: when the media permission is granted after
        // first render, every tile remounts and retries its image instead
        // of keeping the stale red ×.
        // key 里**不能带下标**：拖动排序会改变下标，导致所有格子重新挂载（78 张图
        // 一次全重挂会直接卡死）。用 URI + mediaTick 做 key，排序时只是位置变化，
        // 组件会被复用。mediaTick 用于权限授予后强制重挂以重试图。
        keyExtractor={uri => `${mediaTick}-${uri}`}
        numColumns={COLS}
        // 排序模式下禁掉列表滚动，手势从按下起就由格子全权处理。
        scrollEnabled={!sortMode}
        renderItem={({ item, index }) => (
          // 手势挂在格子外层 View 上：点击 / 长按 / 拖动都在这里判定（见 pan）。
          <View
            ref={node => {
              tileRefs.current[index] = node;
            }}
            {...pan.panHandlers}
            onStartShouldSetResponderCapture={() => {
              pressIndexRef.current = index;
              return true;
            }}
            style={[
              styles.tileOuter,
              { width: size, height: size },
              dragIndex === index && styles.tileLifted,
              dragTarget === index && styles.tileTarget,
              pressedIndex === index && styles.tilePressed,
            ]}
          >
            <DetailThumb
              uri={item}
              fallbackUri={
                item.startsWith('content://') ? remoteUrls[index] : undefined
              }
            />
          </View>
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
        extraData={urisEmpty ? undefined : uris}
      />

      {/* 拖动时跟随手指的悬浮方块 */}
      {dragUri ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.dragGhost,
            {
              width: cell,
              height: cell,
              transform: dragPos.getTranslateTransform(),
            },
          ]}
        >
          <Image
            source={{ uri: dragUri }}
            style={styles.dragGhostImage}
            resizeMode="cover"
          />
        </Animated.View>
      ) : null}

      <ImageViewer
        visible={viewerIndex !== null}
        uris={uris}
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
      <Text style={styles.title}>{decodeHtmlEntities(record.title)}</Text>
      {/^https?:/i.test(record.url) ? (
        <Pressable onPress={onUrlPress} hitSlop={6}>
          <Text style={styles.url} numberOfLines={2}>
            {record.url}
          </Text>
        </Pressable>
      ) : null}
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

/** 格子内容。手势（点击 / 长按 / 拖动）由外层 View 统一处理，这里只管显示。 */
const DetailThumb: React.FC<{
  uri: string;
  /** Optional remote URL to retry with when a local URI fails to open. */
  fallbackUri?: string;
}> = React.memo(({ uri, fallbackUri }) => {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  // When a recorded local content:// URI cannot be opened (e.g. the file was
  // written by an uninstalled build and is not readable), retry once with the
  // record's remote URL so the tile is still useful online.
  const [usingFallback, setUsingFallback] = useState(false);
  const isVideo = isVideoUri(uri);
  // Video URIs cannot be decoded by <Image>; ask MediaStore for a frame.
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!isVideo) return;
    let cancelled = false;
    TelegraphDownloader?.loadMediaThumbnail?.(uri, 256)
      .then(path => {
        if (!cancelled && path) setThumb(path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [uri, isVideo]);

  if (isVideo) {
    // 点视频时由外层把手势交给系统播放器（App 内查看器只能看图）。
    return (
      <View style={styles.tile}>
        {thumb ? (
          <Image
            source={{ uri: thumb }}
            style={styles.image}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.tileVideo} />
        )}
        <View style={styles.tilePlayBadge}>
          <Text style={styles.tilePlayText}>▶</Text>
        </View>
      </View>
    );
  }

  const source = failed && fallbackUri && !usingFallback ? fallbackUri : uri;
  return (
    <View style={styles.tile}>
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
    </View>
  );
});
DetailThumb.displayName = 'DetailThumb';
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
  /** 初次定位完成前先不显示，避免闪一下第一张。 */
  const [ready, setReady] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    if (!visible) {
      setReady(false);
      return;
    }
    setCurrentIndex(initialIndex);
    setZoomed(false);
    // 先把 ScrollView 滚到目标页，再让内容显示出来 —— 否则会先看到第 1 张。
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: initialIndex * width, animated: false });
      setReady(true);
    });
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
          style={[styles.viewerScroll, !ready && styles.viewerHidden]}
          contentContainerStyle={styles.viewerScrollContent}
        >
          {uris.map((uri, index) => (
            <View
              key={`${index}-${uri}`}
              style={[styles.viewerPage, { width }]}
            >
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

  // Videos can't be rendered by the image viewer, so offer the system player.
  if (isVideoUri(uri)) {
    return (
      <View style={styles.viewerPageInner}>
        <View style={styles.viewerErrorBox}>
          <Text style={styles.videoHintText}>{t('history.detail.video')}</Text>
          <Pressable
            onPress={() => playExternally(uri)}
            style={({ pressed }) => [
              styles.retryBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.retryText}>
              {t('history.detail.openExternal')}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

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
    /** 已收藏的星标用主题色高亮。 */
    headerActionActive: { color: c.primary },
    /** 「已标记删除」用警示色。 */
    headerActionWarn: { color: c.danger },
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
      flex: 1,
      backgroundColor: c.surfaceStrong,
      overflow: 'hidden',
    },
    /** 格子的外层容器：负责布局 + 承载手势（点击/长按/拖动）。 */
    tileOuter: {
      margin: GAP / 2,
      backgroundColor: c.surfaceStrong,
      overflow: 'hidden',
    },
    image: { width: '100%', height: '100%' },
    tilePressed: {
      opacity: 0.7,
    },
    /** 被拖起的格子：留个半透明占位（悬浮块跟着手指走）。 */
    tileLifted: {
      opacity: 0.25,
    },
    /** 拖动时手指所在的目标格子：描个边。 */
    tileTarget: {
      borderWidth: 2,
      borderColor: c.primary,
    },
    /** 排序模式提示条。 */
    sortBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: c.primarySoft,
    },
    sortBarText: { flex: 1, fontSize: 12.5, color: c.primarySoftText },
    sortBarBtn: { paddingHorizontal: 10, paddingVertical: 4 },
    sortBarBtnText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.primarySoftText,
    },
    /** 拖动时跟随手指的方块。 */
    dragGhost: {
      position: 'absolute',
      left: 0,
      top: 0,
      zIndex: 30,
      elevation: 12,
      borderRadius: 6,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: c.primary,
      opacity: 0.92,
    },
    dragGhostImage: { width: '100%', height: '100%' },
    tileFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.dangerBg,
    },
    tileFallbackText: { fontSize: 22, color: c.danger, fontWeight: '700' },
    /** Video tile placeholder (before/without a MediaStore thumbnail). */
    tileVideo: { flex: 1, backgroundColor: c.surfaceStrong },
    tilePlayBadge: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: 34,
      height: 34,
      marginTop: -17,
      marginLeft: -17,
      borderRadius: 17,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tilePlayText: { fontSize: 14, color: '#fff', marginLeft: 2 },
    viewerRoot: { flex: 1, backgroundColor: '#000' },
    /** 定位完成前隐藏，避免闪一下第一张。 */
    viewerHidden: { opacity: 0 },
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
    /** Video notice inside the fullscreen viewer. */
    videoHintText: {
      color: '#fff',
      fontSize: 17,
      fontWeight: '600',
      marginBottom: 14,
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
