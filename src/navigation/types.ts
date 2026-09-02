import type {CompositeScreenProps, NavigatorScreenParams} from '@react-navigation/native';
import type {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {TelegraphArticle, TelegraphImage} from '../types/telegraph';

/** Bottom tabs — the main three sections. */
export type MainTabParamList = {
  Batch: undefined;
  History: undefined;
  Settings: undefined;
};

/** Root stack — covers the whole screen (Preview / Download / Privacy). */
export type RootStackParamList = {
  Splash: undefined;
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Preview: {article: TelegraphArticle};
  Download: {article: TelegraphArticle; images: TelegraphImage[]} | undefined;
  Privacy: undefined;
  HistoryDetail: {id: number};
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

export type MainTabScreenProps<T extends keyof MainTabParamList> =
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList, T>,
    NativeStackScreenProps<RootStackParamList>
  >;
