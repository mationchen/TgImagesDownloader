import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainTabs } from './MainTabs';
import { SplashScreen } from '../screens/SplashScreen';
import { PreviewScreen } from '../screens/PreviewScreen';
import { DownloadScreen } from '../screens/DownloadScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen';
import { DownloadProvider } from '../store/DownloadContext';
import { t, useI18n } from '../i18n';
import { useTheme } from '../theme';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

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
          options={{ title: t('history.detail.title') }}
        />
      </Stack.Navigator>
    </DownloadProvider>
  );
};
