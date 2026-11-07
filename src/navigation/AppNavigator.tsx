import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainTabs } from './MainTabs';
import { SplashScreen } from '../screens/SplashScreen';
import { PreviewScreen } from '../screens/PreviewScreen';
import { DownloadScreen } from '../screens/DownloadScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen';
import { FavoriteImagesScreen } from '../screens/FavoriteImagesScreen';
import { TrashScreen } from '../screens/TrashScreen';
import { ImageTrashScreen } from '../screens/ImageTrashScreen';
import { BatchListScreen } from '../screens/BatchListScreen';
import { DownloadProvider } from '../store/DownloadContext';
import { t, useI18n } from '../i18n';
import { useTheme } from '../theme';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const DetailHeaderTitle = ({ children, tintColor }: { children: string; tintColor?: string }) => (
  <Text
    style={[styles.detailTitle, { color: tintColor }]}
    numberOfLines={1}
    adjustsFontSizeToFit
    minimumFontScale={0.75}
    ellipsizeMode="clip"
  >
    {children}
  </Text>
);

export const AppNavigator: React.FC = () => {
  // Subscribe so stack titles re-render in the active language.
  useI18n();
  const { colors } = useTheme();
  return (
    <DownloadProvider>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerStyle: { backgroundColor: colors.headerBackground },
          headerTitleStyle: { color: colors.headerTitle, fontWeight: '600' },
          headerTintColor: colors.primary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen
          name="Splash"
          component={SplashScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Tabs"
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Preview"
          component={PreviewScreen}
          options={{ title: 'Preview' }}
        />
        <Stack.Screen
          name="Download"
          component={DownloadScreen}
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen
          name="Privacy"
          component={PrivacyScreen}
          options={{ title: 'Privacy' }}
        />
        <Stack.Screen
          name="HistoryDetail"
          component={HistoryDetailScreen}
          options={{
            title: t('history.detail.title'),
            headerTitleAlign: 'left',
            headerTitle: DetailHeaderTitle,
          }}
        />
        <Stack.Screen
          name="Trash"
          component={TrashScreen}
          options={{ title: t('trash.title') }}
        />
        <Stack.Screen
          name="BatchList"
          component={BatchListScreen}
          options={{ title: t('batch.title') }}
        />
        <Stack.Screen
          name="FavoriteImages"
          component={FavoriteImagesScreen}
          options={{ title: t('favoriteImages.title') }}
        />
        <Stack.Screen name="ImageTrash" component={ImageTrashScreen}
          options={{ title: t('imageTrash.title') }} />
      </Stack.Navigator>
    </DownloadProvider>
  );
};

const styles = StyleSheet.create({
  detailTitle: { fontSize: 16, fontWeight: '600', transform: [{ translateX: -8 }] },
});
