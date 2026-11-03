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
  setHistoryCover,
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
import { markLastViewedHistory } from '../utils/lastViewed';
import { t, useI18n } from '../i18n';

type Props = RootStackScreenProps<'HistoryDetail'>;

const COLS = 3;
const GAP = 2;
/**
 * 窗口外页面用的空数组常量。
 * 必须是**稳定引用**：每次传新 `[]` 会让 FlatList 认为数据变了而重新渲染。
 */
const EMPTY_ROWS: { index: number; cells: { uri: string; oi: number }[] }[] = [];

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
  const { id, ids, edges, baseOffset = 0, total: totalCount } = route.params;
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

  // 退出详情时把「最后看的那一条」记下来，列表回到前台就能滚到它，
  // 用户滑了几十条也不用再翻找。
  //
  // 用卸载 cleanup 而不是只挂 beforeRemove：手势返回 / 系统返回 / 代码 goBack
  // 三条路都会走到卸载，cleanup 是唯一必定执行的时机。
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      markLastViewedHistory(currentIdRef.current);
    });
    return () => {
      unsubscribe();
      // 卸载兜底（与 beforeRemove 重复写入是幂等的）
      markLastViewedHistory(currentIdRef.current);
    };
  }, [navigation]);

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
                {currentRecord.isFavorite ? '\u2B50' : '\u2606'}
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
                {currentRecord.isMarkedDeleted
                  ? '\u21A9\uFE0F'
                  : '\u{1F6AB}'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                // 重新解析会重新抓整篇文章、覆盖记录的图片列表，先确认再执行。
                Alert.alert(
                  t('history.reparseConfirmTitle'),
                  t('history.reparseConfirmBody'),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('history.reparse'),
                      onPress: () => {
                        onReparse().catch(() => undefined);
                      },
                    },
                  ],
                );
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
                <Text style={styles.headerActionText}>{'\u{1F504}'}</Text>
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
              <Text style={styles.headerActionText}>{'\u{1F5D1}'}</Text>
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

  /**
   * 当前停在的页（用于挂载窗口）。只在**滑动停稳**时更新：
   * 快速甩过很多页时不会一路挂/卸几十个页面。
   */
  const [pagerIndex, setPagerIndex] = useState(initialIndex);
  const pagerRef = useRef<ScrollViewInstance>(null);

  // 初始定位到打开时的那条记录。
  // Android 上 ScrollView 的 `contentOffset` 不保证生效：页面会停在第 0 页，
  // 而挂载窗口在 initialIndex 上 → 那一页是空占位，整屏白页。
  // 这里用 scrollTo 兜底（contentOffset 仍保留，用来抢首帧）。
  useEffect(() => {
    const timer = setTimeout(() => {
      pagerRef.current?.scrollTo({
        x: width * initialIndex,
        y: 0,
        animated: false,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [width, initialIndex]);
  /** 上一次弹过的边界提示，避免同一侧反复弹。 */
  const edgeHintRef = useRef<'start' | 'end' | null>(null);

  const onPagerScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.max(
        0,
        Math.min(pageIds.length - 1, Math.round(e.nativeEvent.contentOffset.x / width)),
      );
      setCurrentIndex(index);
      setPagerIndex(index);
      // 滑到当前页的第一条 / 最后一条：说清楚下一步该怎么做，
      // 而不是让用户对着滑不动的页面发呆。
      if (index === 0 && edgeHintRef.current !== 'start') {
        edgeHintRef.current = 'start';
        ToastAndroid.show(
          edges?.hasPrevPage
            ? t('history.detail.edgePrevPage')
            : t('history.detail.edgeFirst'),
          ToastAndroid.SHORT,
        );
      } else if (
        index === pageIds.length - 1 &&
        edgeHintRef.current !== 'end'
      ) {
        edgeHintRef.current = 'end';
        ToastAndroid.show(
          edges?.hasNextPage
            ? t('history.detail.edgeNextPage')
            : edges?.canLoadMore
            ? t('history.detail.edgeLoadMore')
            : t('history.detail.edgeLast'),
          ToastAndroid.SHORT,
        );
      } else if (index !== 0 && index !== pageIds.length - 1) {
        edgeHintRef.current = null;
      }
    },
    [width, pageIds.length, edges],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      {/*
        为什么不用 FlatList：Fabric（新架构）下 FlatList 的虚拟化会在滑动时
        remove/add cell，触发 `addViewAt: failed to insert view ... index=6
        count=5` 直接闪退（ReactClippingViewManager.addView 的索引竞态）。
        这里改成 ScrollView + **固定数量的占位 View**：ScrollView 的子节点
        永远是 pageIds.length 个，不增不删，recycle 竞态从根上消失；
        只有「当前页 ± 1」真正挂载 RecordPage，内存与原来一致。
      */}
      <ScrollView
        ref={pagerRef}
        style={styles.pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onPagerScrollEnd}
        // Android 上慢速拖动只触发 onScrollEndDrag（没有惯性），
        // 只挂 momentum 会漏掉一半的翻页 —— 边界提示也就弹不出来。
        onScrollEndDrag={onPagerScrollEnd}
        contentOffset={{ x: width * initialIndex, y: 0 }}
        scrollEventThrottle={16}
      >
        {pageIds.map((pageId, index) => (
          // height 必须显式给：横向 ScrollView 的占位子 View 没有内容高度，
          // 只给 width 会塌成 0 高 → 整页白屏（FlatList 的 cell 会自动拉伸，
          // ScrollView 的普通 child 不会）。
          //
          // ⚠️ 这里**永远挂 RecordPage，不再按窗口换成 null**：
          // 之前是 `{近邻 ? <RecordPage/> : null}`，滑动时在 ScrollView 里
          // 动态增删子节点，触发 Fabric 的
          // `removeViewAt: Unable to find parentView for tag ...`
          // （1.0.17 实测崩溃）。改成常挂 + `active` 控制是否加载图片：
          // 结构恒定，内存仍只保留当前页 ±1 的图片。
          <View key={String(pageId)} style={{ width, height: '100%' }}>
            <RecordPage
              id={pageId}
              width={width}
              mediaTick={mediaTick}
              active={Math.abs(index - pagerIndex) <= 1}
              position={baseOffset + index + 1}
              total={totalCount}
            />
          </View>
        ))}
      </ScrollView>
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
  /** 当前记录在列表里的全局序号（从 1 开始）。 */
  position?: number;
  /** 列表命中的总条数。 */
  total?: number;
  /**
   * 是否在「当前页 ±1」的窗口内。false 时**不渲染图片网格**（不占解码内存），
   * 但组件本身保持挂载 —— 见 pager 里关于 Fabric removeViewAt 崩溃的注释。
   */
  active?: boolean;
}> = React.memo(({ id, width, mediaTick, position, total, active = true }) => {
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
  /**
   * 加载失败的图片（URI 集合）。
   * 以前每张失败图都画一个红叉占位，一屏几个红叉很难看；改成页面顶部
   * 一行「N 张加载失败」，格子里留空。
   */
  const [failedUris, setFailedUris] = useState<Set<string>>(new Set());
  const handleThumbStatus = useCallback((uri: string, ok: boolean) => {
    setFailedUris(prev => {
      const has = prev.has(uri);
      if (ok === !has) return prev; // 状态没变，别触发重渲染
      const next = new Set(prev);
      if (ok) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

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
  const baseUris = useMemo(
    () =>
      loadedRecord && (loadedRecord.imagePaths?.length ?? 0) > 0
        ? loadedRecord.imagePaths
        : loadedRecord
        ? fallbackUris
        : [],
    [loadedRecord, fallbackUris],
  );
  /** 实际渲染顺序（拖动中会变）。 */
  const uris = order ? order.map(i => baseUris[i]) : baseUris;
  /**
   * 打不开的图片直接从网格里去掉（用户要求：不要留黑块占位，也不要红叉）。
   * `uris` 仍保留全量 + 顺序，拖动排序换算时用得到。
   */
  const visibleUris = useMemo(
    () => uris.filter(u => !failedUris.has(u)),
    [uris, failedUris],
  );
  const visibleRef = useRef<string[]>([]);
  visibleRef.current = visibleUris;
  const remoteUrls = useMemo(
    () => loadedRecord?.imageUrls ?? [],
    [loadedRecord],
  );
  /** 与 visibleUris 一一对应的远程兜底地址（隐藏的图片不参与）。 */
  const visibleRemoteUrls = useMemo(
    () => visibleUris.map(u => remoteUrls[uris.indexOf(u)] ?? ''),
    [visibleUris, uris, remoteUrls],
  );
  /**
   * 按 COLS 切成「行」：列表一行一个 cell，行内固定 COLS 格。
   * `oi` 是这张图在 `uris`（全量顺序）里的下标 —— 手势与排序都用它，
   * 这样隐藏掉几张图也不会把下标错位。
   * 不用 FlatList 的 numColumns —— Fabric 下它的分组逻辑会崩（见下面的注释）。
   */
  const gridRows = useMemo(() => {
    const out: { index: number; cells: { uri: string; oi: number }[] }[] = [];
    for (let i = 0; i < visibleUris.length; i += COLS) {
      out.push({
        index: i,
        cells: visibleUris
          .slice(i, i + COLS)
          .map(uri => ({ uri, oi: uris.indexOf(uri) })),
      });
    }
    return out;
  }, [visibleUris, uris]);
  const [favoritedUris, setFavoritedUris] = useState<Set<string>>(
    () => new Set(),
  );

  // 按 URI 对应每张图片，拖动排序后角标也跟着图片走。
  // 关闭全屏时重新读取系统状态；清理回调避免旧图集的查询覆盖新图集。
  useEffect(() => {
    if (viewerIndex !== null) return;
    let cancelled = false;
    setFavoritedUris(new Set());
    if (baseUris.length > 0 && TelegraphDownloader?.listFavoritedUris) {
      TelegraphDownloader.listFavoritedUris(baseUris)
        .then(result => {
          if (!cancelled) setFavoritedUris(new Set(result));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [baseUris, viewerIndex]);
  const size = tileSizeFor(width);
  /** 宫格格子改成竖版 3:4（原来正方形会把竖图裁掉一大半）。 */
  const tileH = Math.round((size * 4) / 3);
  const cellW = size + GAP;
  const cellH = tileH + GAP;
  // 只有「顺序来自记录本身」时才允许拖动 —— 否则改了也存不回数据库。
  const reorderable =
    baseUris.length > 1 &&
    (loadedRecord?.imagePaths?.length ?? 0) === baseUris.length;
  reorderableRef.current = reorderable;

  const urisRef = useRef<string[]>([]);
  useEffect(() => {
    urisRef.current = uris;
  }, [uris]);

  // 换了记录（或重解析后图片列表变了）就重置失败统计，别把上一条的失败带过来。
  useEffect(() => {
    setFailedUris(new Set());
  }, [baseUris]);

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
    const imageCount = urisRef.current.length;
    const current =
      orderRef.current ?? Array.from({ length: imageCount }, (_, i) => i);
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
      // 手指坐标 → 网格第几格。网格只画「没失败」的图，所以要换算回 uris 下标，
      // 否则隐藏过图片之后拖动会落到错误的位置。
      const visible = visibleRef.current;
      if (dragIndexRef.current == null || visible.length === 0) return;
      const origin = gridOriginRef.current;
      const col = Math.floor((x - origin.x) / cellW);
      const row = Math.floor((y - origin.y) / cellH);
      const visIdx = Math.max(0, Math.min(row * COLS + col, visible.length - 1));
      const to = urisRef.current.indexOf(visible[visIdx]);
      if (to < 0 || to === targetRef.current) return;
      targetRef.current = to;
      setDragTarget(to);
    },
    [cellW, cellH],
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
            x: g.moveX - pageOriginRef.current.x - cellW / 2,
            y: g.moveY - pageOriginRef.current.y - cellH / 2,
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
    [cellW, cellH, dragPos, finishDrag, moveTo, clearLongPress],
  );

  const beginDrag = useCallback(
    (index: number) => {
      const tile = tileRefs.current[index];
      if (!tile) return;
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      tile.measureInWindow((x: number, y: number) => {
        gridOriginRef.current = { x: x - col * cellW, y: y - row * cellH };
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
    [cellW, cellH, dragPos],
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

  const onThumbPress = useCallback((oi: number) => {
    // `oi` 是 uris（全量）下标，查看器用的是「过滤掉失败图片」后的列表，
    // 这里换算成可见下标，否则点第 6 张可能打开第 5 张。
    const uri = urisRef.current[oi];
    const vi = visibleRef.current.indexOf(uri);
    setViewerIndex(vi >= 0 ? vi : null);
  }, []);
  pressHandlerRef.current = onThumbPress;
  const closeViewer = useCallback(() => setViewerIndex(null), []);

  /** 点「失败 N」徽章：说明这些图为什么被隐藏。 */
  const showFailedHint = useCallback(() => {
    Alert.alert(
      t('history.detail.failedTitle', { count: failedUris.size }),
      t('history.detail.failedHint'),
    );
  }, [failedUris.size]);

  /** 默认封面 = 图集第一张；列表在没有自定义封面时也用它。 */
  const defaultCoverUri = baseUris[0] ?? '';
  /** 实际生效的封面：自定义优先，否则第一张。 */
  const effectiveCoverUri = (loadedRecord?.coverUri || '') || defaultCoverUri;

  /** 全屏里点「封面」：已自定义 → 取消；否则设为这张（第一张本身就是默认）。 */
  const onCoverPress = useCallback(
    (uri: string) => {
      const custom = loadedRecord?.coverUri ?? '';
      if (!custom && uri === defaultCoverUri) {
        ToastAndroid.show(
          t('history.viewer.coverIsDefault'),
          ToastAndroid.SHORT,
        );
        return;
      }
      if (custom && uri === custom) {
        setRecord(prev =>
          prev && prev !== 'loading' ? { ...prev, coverUri: '' } : prev,
        );
        setHistoryCover(id, '').catch(() => undefined);
        ToastAndroid.show(
          t('history.viewer.coverCleared'),
          ToastAndroid.SHORT,
        );
        return;
      }
      setRecord(prev =>
        prev && prev !== 'loading' ? { ...prev, coverUri: uri } : prev,
      );
      setHistoryCover(id, uri)
        .then(() => {
          ToastAndroid.show(
            t('history.viewer.coverSet'),
            ToastAndroid.SHORT,
          );
        })
        .catch(() => undefined);
    },
    [defaultCoverUri, id, loadedRecord?.coverUri],
  );

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

  return (
    <View style={{ width, flex: 1 }} ref={rootRef}>
      {/* 失败图片不再有常驻横幅：数量进「失败」徽章，点了才解释（见 Header）。 */}
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
        // 窗口外的页给空数组：组件仍挂着（避免 Fabric 动态增删子节点），
        // 但不实例化任何图片，内存与原来「只挂当前页 ±1」一致。
        data={active ? gridRows : EMPTY_ROWS}
        // 一行一个 cell、行内固定 COLS 格。
        // **不要用 numColumns**：Fabric 下分组逻辑会往已满的行里插第 4 个格子，
        // 抛 `addViewAt: failed to insert view ... index=4 count=3` 直接闪退。
        keyExtractor={(_, index) => `row-${index}`}
        // 排序模式下禁掉列表滚动，手势从按下起就由格子全权处理。
        scrollEnabled={!sortMode}
        // 一页可能有上百张图：只渲染可视区附近，其余延后。
        // 注意：**不要**加 removeClippedSubviews —— 同样会触发 addViewAt 越界。
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={5}
        renderItem={({ item: row }) => (
          <View style={styles.gridRow}>
            {row.cells.map(({ uri, oi }) => {
              const index = oi;
              return (
                // 手势挂在格子外层 View 上：点击 / 长按 / 拖动都在这里判定（见 pan）。
                <View
                  key={`${mediaTick}-${uri}`}
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
                    { width: size, height: tileH },
                    dragIndex === index && styles.tileLifted,
                    dragTarget === index && styles.tileTarget,
                    pressedIndex === index && styles.tilePressed,
                  ]}
                >
                  <DetailThumb
                    uri={uri}
                    fallbackUri={
                      uri.startsWith('content://')
                        ? remoteUrls[index]
                        : undefined
                    }
                    onStatus={handleThumbStatus}
                  />
                  {record.coverUri === uri ? (
                    <View
                      pointerEvents="none"
                      style={styles.tileCoverBadge}
                      accessibilityRole="image"
                      accessibilityLabel={t('history.viewer.setCover')}
                    >
                      <Text style={styles.tileCoverText}>{'★'}</Text>
                    </View>
                  ) : null}
                  {favoritedUris.has(uri) && !isVideoUri(uri) ? (
                    <View
                      pointerEvents="none"
                      style={styles.tileFavoriteBadge}
                      accessibilityRole="image"
                      accessibilityLabel={t('history.favoriteBadge')}
                    >
                      <Text style={styles.tileFavoriteText}>
                        {'\u2665\uFE0E'}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
            {/* 末行不足 3 格时补空位，保证每一行宽度一致 */}
            {Array.from({ length: Math.max(0, COLS - row.cells.length) }).map(
              (_, k) => (
                <View
                  key={`pad-${k}`}
                  style={[styles.tileOuter, { width: size, height: tileH }]}
                />
              ),
            )}
          </View>
        )}
        ListHeaderComponent={
          <Header
            record={record}
            position={position}
            total={total}
            failedCount={failedUris.size}
            onFailedPress={showFailedHint}
          />
        }
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
        extraData={favoritedUris}
      />

      {/* 拖动时跟随手指的悬浮方块 */}
      {dragUri ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.dragGhost,
            {
              width: cellW,
              height: cellH,
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
        // 只把「能打开」的图片给查看器：失败的那张直接不出现，用户左右滑也不会
        // 撞到一张黑屏。
        uris={visibleUris}
        remoteUris={visibleRemoteUrls}
        coverUri={effectiveCoverUri}
        onCoverPress={onCoverPress}
        initialIndex={viewerIndex ?? 0}
        onClose={closeViewer}
      />
    </View>
  );
});
RecordPage.displayName = 'RecordPage';

const Header: React.FC<{
  record: HistoryRecord;
  /** 当前记录在整个列表里的序号（从 1 开始）。 */
  position?: number;
  /** 列表命中的总条数。 */
  total?: number;
  /** 当前实际打不开的图片数（0 = 全部正常）。 */
  failedCount?: number;
  /** 点「失败」徽章时弹出的说明。 */
  onFailedPress?: () => void;
}> = React.memo(({ record, position, total, failedCount = 0, onFailedPress }) => {
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
        {/* 「失败」= 当前实际打不开的图片数；有才可点，点了解释为什么被隐藏 */}
        <Pressable
          onPress={failedCount > 0 ? onFailedPress : undefined}
          disabled={failedCount === 0}
          hitSlop={6}
        >
          <MetaChip
            label={t('history.detail.failed', {
              count: failedCount > 0 ? failedCount : record.failedCount,
            })}
          />
        </Pressable>
        <MetaChip
          label={`${historyStatusVisual(record.status).icon} ${t(
            HISTORY_STATUS_LABEL_KEY[record.status],
          )}`}
        />
        {position != null && total != null ? (
          <MetaChip
            label={t('history.detail.position', { position, total })}
          />
        ) : null}
        {/* 保存路径也做成徽章：原来单独占一行，右边还有大片空白 */}
        {record.saveDir ? <MetaChip label={record.saveDir} /> : null}
      </View>
      {/* 图集页面上的标签（v7+）。站点本来没有标签时整块不显示。 */}
      {record.tags && record.tags.length > 0 ? (
        <View style={styles.tagsWrap}>
          <Text style={styles.tagsLabel}>{t('history.detail.tags')}</Text>
          {record.tags.map(tag => (
            <View key={tag} style={styles.tagChip}>
              <Text style={styles.tagChipText} numberOfLines={1}>
                {tag}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
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
  /**
   * 上报这张图最终是否加载成功（外层据此在页面顶部统计失败数量）。
   * 失败时格子里留空，不再画红叉。
   */
  onStatus?: (uri: string, ok: boolean) => void;
}> = React.memo(({ uri, fallbackUri, onStatus }) => {
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
  const broken = failed && (!fallbackUri || usingFallback);
  return (
    <View style={styles.tile}>
      {broken ? (
        // 不画红叉：留一块浅色空位，失败数量统一在页面顶部说明。
        <View style={styles.tileBroken} />
      ) : (
        <Image
          source={{ uri: source }}
          style={styles.image}
          resizeMode="cover"
          // Android: 按控件尺寸解码，别把 4000×3000 的原图整张塞进内存
          // （一页几十张缩略图时这是主要的 OOM 来源）。iOS 上是 no-op。
          resizeMethod="resize"
          onLoad={() => onStatus?.(uri, true)}
          onError={() => {
            if (failed && fallbackUri && !usingFallback) {
              // 兜底 URL 也失败了：彻底放弃这张，交给顶部统计。
              setUsingFallback(true);
              onStatus?.(uri, false);
            } else if (!fallbackUri) {
              onStatus?.(uri, false);
            }
            setFailed(true);
          }}
        />
      )}
    </View>
  );
});
DetailThumb.displayName = 'DetailThumb';

/** 挂载窗口半径：当前页左右各保留几页（其余页只占位、不实例化解码组件）。 */
const VIEWER_WINDOW_RADIUS = 2;

/**
 * Minimal paged viewer for content:// URIs recovered from MediaStore.
 * Lighter than the main ViewerModal (which is wired for TelegraphImage and
 * per-image error/probe state).
 *
 * 挂载策略（图片多时点开大图黑屏卡顿的修复）：
 *   1. 刚打开时**只挂载当前这一张**，首帧成本与图片总数无关，立刻能出图；
 *   2. 这张显示出来（onLoadEnd，兜底 800ms）之后，才放开到左右各
 *      {@link VIEWER_WINDOW_RADIUS} 页的窗口，把浏览序列铺开；
 *   3. 滑动停稳后窗口跟着走，远处的页卸载 —— 避免 50+ 张原图同时解码、
 *      同时占着内存（那正是原来黑屏卡顿的原因）。
 */
const ImageViewer: React.FC<{
  visible: boolean;
  uris: string[];
  initialIndex: number;
  /** 与 uris 一一对应的远程地址：本地打不开时回退（老记录存在 WebP 存成 .jpg 的情况）。 */
  remoteUris?: string[];
  /** 实际生效的封面（自定义优先，否则是第一张）——用于按钮的点亮状态。 */
  coverUri?: string;
  /** 点「封面」按钮（设为 / 取消由上层判断）。 */
  onCoverPress?: (uri: string) => void;
  onClose: () => void;
}> = ({ visible, uris, initialIndex, remoteUris, coverUri, onCoverPress, onClose }) => {
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
  /**
   * 挂载窗口的基准页。只在**滑动停稳**时更新：正常翻页时邻居早已挂好，
   * 而快速甩过很多页时不会一路挂/卸几十张图（那比黑一下更卡）。
   */
  const [anchor, setAnchor] = useState(initialIndex);
  /** 是否已放开挂载窗口 —— 首图显示出来之后才为 true。 */
  const [windowOpen, setWindowOpen] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);

  /**
   * 放开窗口：首图已经画出来之后，再等一小会儿（让弹窗淡入这一帧画完），
   * 避免挂载邻页的解码工作跟首图抢主线程。
   */
  const openWindow = useCallback(() => {
    setTimeout(() => setWindowOpen(true), 150);
  }, []);

  /* ---- 系统收藏夹（♥）：Android 11+ 的 MediaStore.IS_FAVORITE ---- */

  // 大图是横向分页的，这里算的是「当前这一页」对应的图片。
  const viewerUri =
    uris[Math.min(currentIndex, Math.max(0, uris.length - 1))] ?? '';
  /** 视频不能收藏；原生侧没有该方法（iOS / 旧安装包）时也不显示按钮。 */
  const canFavorite =
    viewerUri.length > 0 &&
    !isVideoUri(viewerUri) &&
    TelegraphDownloader?.setMediaFavorite != null;
  /** 系统收藏夹状态：null = 未知 / 不支持。 */
  const [isFavorite, setIsFavorite] = useState<boolean | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);

  // 换页 / 重新打开时读一次系统收藏状态（DB 里没有这个信息，只能问系统）。
  useEffect(() => {
    if (!visible || !canFavorite) {
      setIsFavorite(null);
      return;
    }
    let cancelled = false;
    TelegraphDownloader?.isMediaFavorite?.(viewerUri)
      .then(v => {
        if (!cancelled) setIsFavorite(v);
      })
      .catch(() => {
        if (!cancelled) setIsFavorite(null);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, viewerUri, canFavorite]);

  /** 加入 / 取消系统收藏夹：先乐观翻转图标，失败再翻回来。 */
  const onToggleFavorite = useCallback(() => {
    if (!canFavorite || favoriteBusy) return;
    // 还没读到系统状态时按「加入」处理（写入的是"收藏 = 是"，重复写无副作用）。
    const next = isFavorite !== true;
    setIsFavorite(next);
    setFavoriteBusy(true);
    TelegraphDownloader?.setMediaFavorite?.(viewerUri, next)
      .then(() => {
        ToastAndroid.show(
          t(next ? 'history.viewer.favorited' : 'history.viewer.unfavorited'),
          ToastAndroid.SHORT,
        );
      })
      .catch(() => {
        setIsFavorite(!next);
        ToastAndroid.show(
          t('history.viewer.favoriteFailed'),
          ToastAndroid.SHORT,
        );
      })
      .finally(() => setFavoriteBusy(false));
  }, [canFavorite, favoriteBusy, isFavorite, viewerUri]);

  useEffect(() => {
    if (!visible) {
      setReady(false);
      setWindowOpen(false);
      return;
    }
    setCurrentIndex(initialIndex);
    setAnchor(initialIndex);
    setZoomed(false);
    setWindowOpen(false);
    // 兜底：视频页不会回调 onLoadEnd，图片解码极慢时也可能迟迟不回调 ——
    // 800ms 后无条件放开窗口，免得永远只能看第一张。
    const fallback = setTimeout(openWindow, 800);
    // 先把 ScrollView 滚到目标页，再让内容显示出来 —— 否则会先看到第 1 张。
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: initialIndex * width, animated: false });
      setReady(true);
    });
    return () => clearTimeout(fallback);
  }, [visible, initialIndex, width, openWindow]);

  // Reset zoom whenever the visible page changes (only reachable while at 1x).
  useEffect(() => {
    setZoomed(false);
  }, [currentIndex]);

  const handleScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / width);
      if (idx < 0 || idx >= uris.length) return;
      if (idx !== currentIndex) setCurrentIndex(idx);
      if (idx !== anchor) setAnchor(idx);
    },
    [currentIndex, anchor, uris.length, width],
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
          {/* 页码绝对居中：左右两侧的按钮多少都不影响它的位置 */}
          <View pointerEvents="none" style={styles.viewerCounterWrap}>
            <Text style={styles.viewerCounter}>
              {t('preview.viewerIndex', {
                current: safeIndex + 1,
                total: uris.length,
              })}
            </Text>
          </View>
          <View style={styles.viewerActions}>
            {/* 收藏：文字按钮，和「封面」同一套外观 */}
            {canFavorite ? (
              <Pressable
                onPress={onToggleFavorite}
                disabled={favoriteBusy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ selected: isFavorite === true }}
                accessibilityLabel={
                  isFavorite
                    ? t('history.viewer.unfavorite')
                    : t('history.viewer.favorite')
                }
                style={({ pressed }) => [
                  styles.viewerPill,
                  isFavorite && styles.viewerPillOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.viewerPillText,
                    isFavorite && styles.viewerPillTextOn,
                  ]}
                >
                  {isFavorite
                    ? t('history.viewer.favOn')
                    : t('history.viewer.favOff')}
                </Text>
              </Pressable>
            ) : null}
            {/* 封面：当前这张就是封面时点亮；再点一次取消（回到默认第一张）。 */}
            {onCoverPress && viewerUri && !isVideoUri(viewerUri) ? (
              <Pressable
                onPress={() => onCoverPress(viewerUri)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ selected: viewerUri === coverUri }}
                accessibilityLabel={t('history.viewer.cover')}
                style={({ pressed }) => [
                  styles.viewerPill,
                  viewerUri === coverUri && styles.viewerPillOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.viewerPillText,
                    viewerUri === coverUri && styles.viewerPillTextOn,
                  ]}
                >
                  {t('history.viewer.cover')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          onScrollEndDrag={handleScrollEnd}
          scrollEventThrottle={32}
          style={[styles.viewerScroll, !ready && styles.viewerHidden]}
          contentContainerStyle={styles.viewerScrollContent}
        >
          {uris.map((uri, index) => {
            // 窗口外的页只留占位 View（父级是纯黑背景），不实例化 Image /
            // PanResponder / Animated，几十张一起挂的开销就没有了。
            const mounted = windowOpen
              ? Math.abs(index - anchor) <= VIEWER_WINDOW_RADIUS
              : index === initialIndex;
            return (
              <View
                key={`${index}-${uri}`}
                style={[styles.viewerPage, { width }]}
              >
                {mounted ? (
                  <ImageViewerPage
                    uri={uri}
                    fallbackUri={remoteUris?.[index]}
                    onZoomChange={index === safeIndex ? setZoomed : undefined}
                    onLoaded={
                      !windowOpen && index === initialIndex
                        ? openWindow
                        : undefined
                    }
                  />
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const ImageViewerPage: React.FC<{
  uri: string;
  /** 本地地址打不开时的远程兜底（老记录里存在 WebP 存成 .jpg 的情况）。 */
  fallbackUri?: string;
  onZoomChange?: (zoomed: boolean) => void;
  /** 首次画出（或确认加载失败）时回调：父组件据此放开挂载窗口。 */
  onLoaded?: () => void;
}> = ({ uri, fallbackUri, onZoomChange, onLoaded }) => {
  // Subscribe so retry/error strings track the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  /** local → 本地地址；remote → 已切到远程兜底；error → 两张都失败。 */
  const [phase, setPhase] = useState<'local' | 'remote' | 'error'>('local');
  const [retryKey, setRetryKey] = useState(0);
  const source = phase === 'remote' && fallbackUri ? fallbackUri : uri;
  const failed = phase === 'error';

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
              setPhase('local');
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
          key={`${retryKey}-${phase}`}
          uri={source}
          onZoomChange={onZoomChange}
          onLoadEnd={onLoaded}
          onError={() => {
            // 本地打不开先换远程再试一次；只有两张都失败才显示错误页。
            if (phase === 'local' && fallbackUri) {
              setPhase('remote');
              return;
            }
            setPhase('error');
            // 失败也要让父组件放开窗口，否则只能看到这一张错误页。
            onLoaded?.();
          }}
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
    headerActionText: { fontSize: 18, lineHeight: 22, color: c.headerTitle },
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
      // 路径可能很长：允许收缩 + 省略号，别把整行撑出屏幕
      flexShrink: 1,
      maxWidth: '100%',
    },
    chipText: { fontSize: 11, color: c.textSecondary, flexShrink: 1 },
    /** 标签区：跟在元信息下面，独立一行，可换行。 */
    tagsWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      marginTop: 8,
      gap: 6,
    },
    tagsLabel: { fontSize: 11, color: c.textHint },
    /** 标签胶囊：比元信息徽章更醒目一点（主题色描边）。 */
    tagChip: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.primary,
      maxWidth: '100%',
      flexShrink: 1,
    },
    tagChipText: { fontSize: 11, color: c.primary, flexShrink: 1 },
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
    /** 一行 3 格（替代 FlatList 的 numColumns） */
    gridRow: { flexDirection: 'row' },
    /** 加载失败的格子：留一块浅色空位，不再画红叉。 */
    tileBroken: { flex: 1, backgroundColor: c.surfaceStrong },
    /** 页面顶部「N 张图片加载失败」条（固定、不随网格滚动）。 */
    failedBar: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    failedBarText: { fontSize: 12, color: c.textHint },
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
    tileFavoriteBadge: {
      position: 'absolute',
      top: 6,
      right: 6,
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileFavoriteText: { fontSize: 18, lineHeight: 22, color: '#FF4D6D' },
    /** 封面角标（★）：和收藏角标不同位置，两者可同时出现。 */
    tileCoverBadge: {
      position: 'absolute',
      bottom: 6,
      right: 6,
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileCoverText: { fontSize: 15, lineHeight: 20, color: '#FFD166' },
    /** 系统收藏夹按钮（♥ / ♡）。用文字呈现变体 U+FE0E，颜色才能自定义。 */
    viewerFavText: { fontSize: 18, lineHeight: 22 },
    viewerFavTextOn: { color: '#FF4D6D' },
    /** 全屏顶栏右侧的文字按钮（收藏 / 封面）——同一套外观。 */
    viewerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /** 页码居中用的绝对定位层：左右按钮数量变化不会挪动它。 */
    viewerCounterWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    viewerPill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.5)',
    },
    viewerPillOn: {
      backgroundColor: '#FFD166',
      borderColor: '#FFD166',
    },
    viewerPillText: {
      fontSize: 13,
      lineHeight: 16,
      color: '#fff',
      fontWeight: '600',
    },
    viewerPillTextOn: { color: '#1a1a1a' },
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
