import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {TelegraphArticle, TelegraphImage} from '../types/telegraph';

export type RootStackParamList = {
  Home: undefined;
  History: undefined;
  Privacy: undefined;
  Preview: {article: TelegraphArticle};
  Download: {article: TelegraphArticle; images: TelegraphImage[]};
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;
