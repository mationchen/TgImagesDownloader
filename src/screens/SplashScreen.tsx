import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RootStackScreenProps } from '../navigation/types';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';

type Props = RootStackScreenProps<'Splash'>;

export const SplashScreen: React.FC<Props> = ({ navigation }) => {
  // Subscribe so the app name renders in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  useEffect(() => {
    const timer = setTimeout(() => {
      navigation.replace('Tabs');
    }, 1800);
    return () => clearTimeout(timer);
  }, [navigation]);

  return (
    <SafeAreaView
      style={styles.safe}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <View style={styles.center}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>⬇</Text>
        </View>
        <Text style={styles.appName}>{t('splash.appName')}</Text>
        <Text style={styles.subtitle}>{t('splash.subtitle')}</Text>
        <Text style={styles.desc}>{t('splash.desc')}</Text>
      </View>
      <View style={styles.footer}>
        <Text style={styles.studio}>Alexandia Chen Studio</Text>
        <Text style={styles.website}>acstd.com</Text>
      </View>
    </SafeAreaView>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
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
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 20,
    },
    logoText: { fontSize: 40, color: c.textOnPrimary, fontWeight: '700' },
    appName: {
      fontSize: 22,
      fontWeight: '700',
      color: c.textPrimary,
      textAlign: 'center',
    },
    subtitle: {
      marginTop: 8,
      fontSize: 15,
      fontWeight: '600',
      color: c.primary,
      textAlign: 'center',
    },
    desc: {
      marginTop: 10,
      fontSize: 13,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 19,
    },
    footer: {
      alignItems: 'center',
      paddingBottom: 28,
      gap: 4,
    },
    studio: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textSecondary,
      letterSpacing: 0.3,
    },
    website: { fontSize: 12, color: c.textHint },
  });
}
