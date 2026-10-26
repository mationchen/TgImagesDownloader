import React, { useCallback, useRef } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  BackHandler,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { HomeScreen } from '../screens/HomeScreen';
import { BatchListScreen } from '../screens/BatchListScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { t, useI18n } from '../i18n';
import { useTheme } from '../theme';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

/** 「再按一次退出」的判定窗口：2 秒内连按两次返回键才退出。 */
const DOUBLE_BACK_EXIT_MS = 2000;

const TAB_ICONS: Record<keyof MainTabParamList, string> = {
  Batch: '⬇',
  UrlList: '📋',
  History: '🕘',
  Settings: '⚙',
};

type IconProps = { name: string; focused: boolean; color: string };
const TabIcon: React.FC<IconProps> = ({ name, focused, color }) => (
  <Text
    style={[
      styles.icon,
      focused ? styles.iconFocused : styles.iconBlurred,
      { color },
    ]}
  >
    {TAB_ICONS[name as keyof MainTabParamList] ?? ''}
  </Text>
);

export const MainTabs: React.FC = () => {
  // Subscribe so tab labels re-render in the active language.
  useI18n();
  const { colors } = useTheme();
  /** 上一次按返回键的时间（ms），用于「再按一次退出」判定。 */
  const lastBackPressRef = useRef(0);

  // 一级页面（Tab 页）的返回键：第一次提示，2 秒内再按一次才真正退出。
  // 监听只在 Tab 页处于焦点时挂载 —— 栈上压了详情页时，返回键照旧交给导航栈。
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        const now = Date.now();
        if (now - lastBackPressRef.current < DOUBLE_BACK_EXIT_MS) {
          BackHandler.exitApp();
          return true;
        }
        lastBackPressRef.current = now;
        ToastAndroid.show(t('common.pressBackAgain'), ToastAndroid.SHORT);
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.headerBackground,
          borderTopColor: colors.border,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        // eslint-disable-next-line react/no-unstable-nested-components
        tabBarIcon: ({
          focused,
          color,
        }: {
          focused: boolean;
          color: string;
        }) => <TabIcon name={route.name} focused={focused} color={color} />,
      })}
    >
      <Tab.Screen
        name="Batch"
        component={HomeScreen}
        options={{ tabBarLabel: t('tab.batch') }}
      />
      <Tab.Screen
        name="UrlList"
        component={BatchListScreen}
        options={{ tabBarLabel: t('tab.urlList') }}
      />
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{ tabBarLabel: t('tab.history') }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarLabel: t('tab.settings') }}
      />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  icon: { fontSize: 18 },
  iconFocused: { opacity: 1 },
  iconBlurred: { opacity: 0.6 },
});
