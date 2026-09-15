import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StyleSheet, Text } from 'react-native';
import { HomeScreen } from '../screens/HomeScreen';
import { BatchListScreen } from '../screens/BatchListScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { t, useI18n } from '../i18n';
import { useTheme } from '../theme';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

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
