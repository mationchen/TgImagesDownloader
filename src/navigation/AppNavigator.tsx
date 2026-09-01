import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {HomeScreen} from '../screens/HomeScreen';
import {HistoryScreen} from '../screens/HistoryScreen';
import {PrivacyScreen} from '../screens/PrivacyScreen';
import {PreviewScreen} from '../screens/PreviewScreen';
import {DownloadScreen} from '../screens/DownloadScreen';
import {DownloadProvider} from '../store/DownloadContext';
import type {RootStackParamList} from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator: React.FC = () => {
  return (
    <Stack.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerStyle: {backgroundColor: '#fff'},
        headerTitleStyle: {color: '#111', fontWeight: '600'},
        headerTintColor: '#1976d2',
        headerShadowVisible: false,
        contentStyle: {backgroundColor: '#fff'},
      }}>
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="History"
        component={HistoryScreen}
        options={{title: 'History'}}
      />
      <Stack.Screen
        name="Privacy"
        component={PrivacyScreen}
        options={{title: 'Privacy'}}
      />
      <Stack.Screen
        name="Preview"
        component={PreviewScreen}
        options={{title: 'Preview'}}
      />
      <Stack.Screen
        name="Download"
        options={{title: 'Download', headerBackVisible: false, gestureEnabled: false}}>
        {props => (
          <DownloadProvider>
            <DownloadScreen {...props} />
          </DownloadProvider>
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
};