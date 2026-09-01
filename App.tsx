/**
 * Telegraph Downloader — root component.
 *
 * Owns the app-wide SafeAreaProvider and NavigationContainer so descendant
 * screens (HomeScreen, PreviewScreen, future Download/History/Settings)
 * can rely on safe-area + navigation context.
 *
 * Phase 3: HomeScreen -> PreviewScreen wired via native stack navigator.
 */

import React from 'react';
import {StatusBar, useColorScheme} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {NavigationContainer} from '@react-navigation/native';
import {AppNavigator} from './src/navigation/AppNavigator';

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default App;
