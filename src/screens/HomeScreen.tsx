import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import { EmptyState } from '../components/EmptyState';
import { UrlInput } from '../components/UrlInput';
import { parseArticle } from '../services/telegraphParser';
import {
  initHistoryDatabase,
  listHistory,
  type HistoryRecord,
} from '../services/historyService';
import {
  consumePendingShare,
  getInitialShare,
  subscribeToShares,
} from '../services/shareIntentService';
import type { MainTabScreenProps } from '../navigation/types';
import { extractWebUrls, validateWebUrl } from '../utils/url';
import { getSettingsSync, loadSettings } from '../services/settingsService';
import { useDownload } from '../store/DownloadContext';
import { t } from '../i18n';
import { errorMessage } from '../utils/errorMessage';

type Props = MainTabScreenProps<'Batch'>;

export const HomeScreen: React.FC<Props> = ({ navigation }) => {
  const isDarkMode = useColorScheme() === 'dark';
  const { summary } = useDownload();
  const hasActiveDownload = !summary.finished && summary.total > 0;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<
    import('../types/telegraph').ParseErrorCode | undefined
  >(undefined);
  const [recent, setRecent] = useState<HistoryRecord[]>([]);

  // A stable callback that accepts a shared/clipboard text, extracts the first
  // http(s) URL (only when autoFillClipboard is on), and fills the input
  // (but never auto-parses without the user tapping Parse).
  const applySharedText = useCallback((text: string | null | undefined) => {
    if (!text) return;
    const urls = extractWebUrls(text);
    if (urls.length === 0) return;
    // Defensive URL validation: reject non-http(s), loopback, etc.
    const safe = urls.find(u => validateWebUrl(u) === null);
    if (!safe) return;
    if (!getSettingsSync().autoFillClipboard) return;
    // Merge with existing input, deduping.
    setInput(prev => {
      const merged = [safe, ...(prev ? extractWebUrls(prev) : [])];
      const seen = new Set<string>();
      return merged
        .filter(u => (seen.has(u) ? false : (seen.add(u), true)))
        .join('\n');
    });
    setErrorCode(undefined);
  }, []);

  const detected = useMemo(() => extractWebUrls(input), [input]);

  // Refresh recent history + drain any buffered share whenever the Home
  // screen gains focus (e.g. after a download finishes and the user returns).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          await initHistoryDatabase();
          await loadSettings();
          const items = await listHistory(5);
          const pending = await consumePendingShare();
          if (cancelled) return;
          setRecent(items);
          if (pending?.hasUrl) applySharedText(pending.url);
        } catch {
          if (!cancelled) setRecent([]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [applySharedText]),
  );

  // Phase 7: consume a share intent on cold start / warm start, and subscribe
  // to live share events (Chrome -> Share -> this app).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [initial, pending] = await Promise.all([
        getInitialShare(),
        consumePendingShare(),
      ]);
      if (cancelled) return;
      if (initial?.hasUrl) applySharedText(initial.url);
      else if (pending?.hasUrl) applySharedText(pending.url);
    })();
    const unsub = subscribeToShares(payload => {
      if (payload?.hasUrl) applySharedText(payload.url);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [applySharedText]);

  // Spec §2.1: auto-detect a Telegraph URL from the clipboard when the screen
  // first mounts (only if the input is still empty and nothing was shared in).
  const clipboardChecked = React.useRef(false);
  useEffect(() => {
    if (clipboardChecked.current) return;
    clipboardChecked.current = true;
    (async () => {
      try {
        const text = await Clipboard.getString();
        applySharedText(text);
      } catch {
        // Clipboard read can fail on some devices; ignore.
      }
    })();
  }, [applySharedText]);

  const handleClear = useCallback(() => {
    setInput('');
    setErrorCode(undefined);
  }, []);

  const handleParse = useCallback(async () => {
    const target = detected[0];
    if (!target) {
      setErrorCode('INVALID_URL');
      return;
    }
    setErrorCode(undefined);
    setLoading(true);
    const result = await parseArticle(target);
    setLoading(false);
    if (result.ok && result.article) {
      navigation.navigate('Preview', { article: result.article });
      return;
    }
    setErrorCode(result.error?.code);
  }, [detected, navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>{t('home.title')}</Text>
            <Text style={styles.subtitle}>{t('home.subtitle')}</Text>
          </View>
          <Pressable
            onPress={() => navigation.navigate('Download' as never)}
            hitSlop={12}
            style={({ pressed }) => [
              styles.downloadIconBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.downloadIcon}>⬇</Text>
            {hasActiveDownload ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {summary.downloading + summary.pending}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
        <UrlInput
          value={input}
          onChange={setInput}
          onSubmit={handleParse}
          onClear={handleClear}
          loading={loading}
          containerStyle={styles.urlInputContainer}
        />
        <View style={styles.recentSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>{t('home.recent')}</Text>
            {recent.length > 0 ? (
              <Pressable
                onPress={() =>
                  navigation.navigate('Tabs', { screen: 'History' })
                }
                hitSlop={8}
              >
                <Text style={styles.viewAll}>{t('history.viewAll')}</Text>
              </Pressable>
            ) : null}
          </View>
          {recent.length === 0 ? (
            <View style={[styles.recentCard, styles.recentCardFlex]}>
              <EmptyState title={t('home.recentEmpty')} />
            </View>
          ) : (
            <View style={styles.recentCard}>
              <ScrollView
                contentContainerStyle={styles.recentScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                {recent.map((r, idx) => (
                  <RecentRow
                    key={r.id}
                    record={r}
                    divider={idx < recent.length - 1}
                    onPress={() =>
                      navigation.navigate('Tabs', { screen: 'History' })
                    }
                  />
                ))}
              </ScrollView>
            </View>
          )}
        </View>
        {errorCode ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage(errorCode)}</Text>
          </View>
        ) : null}
        <View style={styles.footer}>
          <Pressable onPress={() => navigation.navigate('Privacy')} hitSlop={8}>
            <Text style={styles.privacyLink}>{t('privacy.link')}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#fff',
  },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerLeft: { flex: 1, paddingRight: 12 },
  downloadIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#eef4fb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadIcon: { fontSize: 18, color: '#1976d2' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#d32f2f',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 9, color: '#fff', fontWeight: '700' },
  pressed: { opacity: 0.6 },
  urlInputContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    color: '#666',
  },
  body: {
    flexGrow: 1,
    paddingHorizontal: 16,
  },
  recentSection: {
    flex: 1,
    marginTop: 8,
    paddingHorizontal: 16,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#444',
    marginBottom: 8,
  },
  recentCard: {
    flex: 1,
    backgroundColor: '#f6f8fa',
    borderRadius: 10,
    minHeight: 120,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e0e0e0',
    overflow: 'hidden',
  },
  recentCardFlex: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentScroll: {
    flex: 1,
  },
  recentScrollContent: {
    paddingBottom: 8,
  },
  errorBox: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fdecec',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#f5c6c6',
  },
  errorText: {
    color: '#a32',
    fontSize: 13,
  },
  footer: {
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 4,
    paddingBottom: 8,
  },
  privacyLink: {
    fontSize: 12,
    color: '#888',
    textDecorationLine: 'underline',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  viewAll: {
    fontSize: 12,
    color: '#1976d2',
  },
  recentRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recentRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ececec',
  },
  recentTitle: {
    flex: 1,
    fontSize: 14,
    color: '#222',
    fontWeight: '500',
  },
  recentCount: {
    marginLeft: 12,
    fontSize: 12,
    color: '#888',
    fontVariant: ['tabular-nums'],
  },
});

const RecentRow: React.FC<{
  record: HistoryRecord;
  divider: boolean;
  onPress: () => void;
}> = ({ record, divider, onPress }) => {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.recentRow,
        divider && styles.recentRowDivider,
        pressed && { backgroundColor: '#eef4fb' },
      ]}
    >
      <Text style={styles.recentTitle} numberOfLines={1}>
        {record.title}
      </Text>
      <Text style={styles.recentCount}>
        {t('history.itemCount', { count: record.imageCount })}
      </Text>
    </Pressable>
  );
};
