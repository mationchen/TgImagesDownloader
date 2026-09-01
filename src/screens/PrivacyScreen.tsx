import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {t} from '../i18n';

type Props = {};

export const PrivacyScreen: React.FC<Props> = () => {
  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{t('privacy.title')}</Text>
        <Paragraph>{t('privacy.intro')}</Paragraph>
        <Bullet>{t('privacy.noAccount')}</Bullet>
        <Bullet>{t('privacy.noUpload')}</Bullet>
        <Bullet>{t('privacy.noCollect')}</Bullet>
        <Bullet>{t('privacy.localHistory')}</Bullet>
        <Bullet>{t('privacy.permissions')}</Bullet>
        <Paragraph>{t('privacy.contact')}</Paragraph>
      </ScrollView>
    </SafeAreaView>
  );
};

const Paragraph: React.FC<{children: string}> = ({children}) => {
  return <Text style={styles.paragraph}>{children}</Text>;
};

const Bullet: React.FC<{children: string}> = ({children}) => {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
    marginBottom: 16,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 22,
    color: '#333',
    marginBottom: 12,
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  bulletDot: {
    width: 16,
    fontSize: 14,
    color: '#1976d2',
    lineHeight: 22,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 22,
    color: '#333',
  },
});