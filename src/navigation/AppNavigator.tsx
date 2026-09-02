import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MainTabs } from './MainTabs';
import { SplashScreen } from '../screens/SplashScreen';
import { PreviewScreen } from '../screens/PreviewScreen';
import { DownloadScreen } from '../screens/DownloadScreen';
import { PrivacyScreen } from '../screens/PrivacyScreen';
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen';
import { DownloadProvider } from '../store/DownloadContext';
import { t } from '../i18n';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator: React.FC = () => {
  return (
    <DownloadProvider>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerStyle: { backgroundColor: '#fff' },
          headerTitleStyle: { color: '#111', fontWeight: '600' },
          headerTintColor: '#1976d2',
          headerShadowVisible: false,
          contentStyle: { backgroundColor: '#fff' },
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
