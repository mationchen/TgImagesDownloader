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
        <Text style={styles.effective}>{t('privacy.effectiveDate')}</Text>
        <Paragraph>{t('privacy.intro')}</Paragraph>

        <Section
          title={t('privacy.section1Title')}
          body={t('privacy.section1Body')}
        />
        <Section
          title={t('privacy.section2Title')}
          body={t('privacy.section2Body')}
        />
        <Section
          title={t('privacy.section3Title')}
          body={t('privacy.section3Body')}
        />
        <Section
          title={t('privacy.section4Title')}
          body={t('privacy.section4Body')}
        />
        <Section
          title={t('privacy.section5Title')}
          body={t('privacy.section5Body')}
        />
        <Section
          title={t('privacy.section6Title')}
          body={t('privacy.section6Body')}
        />
        <Section
          title={t('privacy.section7Title')}
          body={t('privacy.section7Body')}
        />
        <Section
          title={t('privacy.section8Title')}
          body={t('privacy.section8Body')}
        />
      </ScrollView>
    </SafeAreaView>
  );
};

const Paragraph: React.FC<{children: string}> = ({children}) => {
  return <Text style={styles.paragraph}>{children}</Text>;
};

const Section: React.FC<{title: string; body: string}> = ({title, body}) => {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{body}</Text>
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
    marginBottom: 4,
  },
  effective: {
    fontSize: 12,
    color: '#888',
    marginBottom: 16,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 22,
    color: '#333',
    marginBottom: 18,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    marginBottom: 6,
  },
  sectionBody: {
    fontSize: 14,
    lineHeight: 22,
    color: '#333',
  },
});