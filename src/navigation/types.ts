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
  History: undefined;
  Settings: undefined;
};

/** Root stack — covers the whole screen (Preview / Download / Privacy). */
export type RootStackParamList = {
  Splash: undefined;
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Preview: { article: TelegraphArticle };
  Download: { article: TelegraphArticle; images: TelegraphImage[] } | undefined;
  Privacy: undefined;
  /**
   * `ids` is the ordered list the user came from (so the detail screen can be
   * swiped left/right between neighbouring records). Optional: callers that
   * only have a single id (e.g. the Home duplicate-link alert) omit it and the
   * screen shows a single, non-swipeable page.
   */
  HistoryDetail: { id: number; ids?: number[] };
  BatchList: undefined;
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

export type MainTabScreenProps<T extends keyof MainTabParamList> =
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList, T>,
    NativeStackScreenProps<RootStackParamList>
  >;
