import type {
  CompositeScreenProps,
  NavigatorScreenParams,
} from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { TelegraphArticle, TelegraphImage } from '../types/telegraph';

/** Bottom tabs — the main sections. */
export type MainTabParamList = {
  Batch: undefined;
  UrlList: undefined;
  /**
   * `tag` lets other screens (e.g. 下载记录详情里点标签）打开下载记录并按标签筛选。
   * 消费后立即 `setParams({ tag: undefined })`，避免下次进入 Tab 又被旧标签套上。
   */
  History: { tag?: string } | undefined;
  Settings: undefined;
};

/** 详情页左右滑到当前页第一条 / 最后一条时，告诉用户下一步能做什么。 */
export interface HistoryEdgeInfo {
  /** 本页不是第一页（前面还有更靠前的记录）。 */
  hasPrevPage: boolean;
  /** 后面还有下一页。 */
  hasNextPage: boolean;
  /** 本页还没加载满、但数据库里还有更多（回列表继续加载即可）。 */
  canLoadMore: boolean;
}

/** Root stack — covers the whole screen (Preview / Download / Privacy). */
export type RootStackParamList = {
  Splash: undefined;
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Preview: { article: TelegraphArticle };
  Download: { article: TelegraphArticle; images: TelegraphImage[] } | undefined;
  Privacy: undefined;
  /** 回收站：已标记删除并移入的记录（可恢复 / 一键清空）。 */
  Trash: undefined;
  /**
   * `ids` is the ordered list the user came from (so the detail screen can be
   * swiped left/right between neighbouring records). Optional: callers that
   * only have a single id (e.g. the Home duplicate-link alert) omit it and the
   * screen shows a single, non-swipeable page.
   *
   * `edges` tells the detail screen what lies beyond the first / last id so a
   * swipe past the edge can explain the next step instead of silently stopping.
   */
  HistoryDetail: {
    id: number;
    ids?: number[];
    edges?: HistoryEdgeInfo;
    /** 列表当前页的起始偏移：详情页用它显示「第 N / 共 M 条」的全局序号。 */
    baseOffset?: number;
    /** 列表命中的总条数（同上）。 */
    total?: number;
  };
  BatchList: undefined;
  /** App 内收藏的所有图片（跨记录）。 */
  FavoriteImages: undefined;
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

export type MainTabScreenProps<T extends keyof MainTabParamList> =
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList, T>,
    NativeStackScreenProps<RootStackParamList>
  >;
