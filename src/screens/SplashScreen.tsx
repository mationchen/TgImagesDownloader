import React, {useEffect} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {RootStackScreenProps} from '../navigation/types';

type Props = RootStackScreenProps<'Splash'>;

export const SplashScreen: React.FC<Props> = ({navigation}) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      navigation.replace('Tabs');
    }, 1800);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.center}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>⬇</Text>
        </View>
        <Text style={styles.appName}>网页图片批量下载器</Text>
        <Text style={styles.subtitle}>网页图集一键批量保存至相册</Text>
        <Text style={styles.desc}>
          支持任意网页，自动识别分页，批量下载并按原文顺序保存
        </Text>
      </View>
      <View style={styles.footer}>
        <Text style={styles.studio}>Alexandia Chen Studio</Text>
        <Text style={styles.website}>acstd.com</Text>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logoCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#1565C0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  logoText: {fontSize: 40, color: '#fff', fontWeight: '700'},
  appName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: '600',
    color: '#1976d2',
    textAlign: 'center',
  },
  desc: {
    marginTop: 10,
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    lineHeight: 19,
  },
  footer: {
    alignItems: 'center',
    paddingBottom: 28,
    gap: 4,
  },
  studio: {fontSize: 13, fontWeight: '600', color: '#333', letterSpacing: 0.3},
  website: {fontSize: 12, color: '#888'},
});
