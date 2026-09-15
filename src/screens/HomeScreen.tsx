import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import { EmptyState } from '../components/EmptyState';
import { UrlInput } from '../components/UrlInput';
import { parseArticle, type ParseStage } from '../services/telegraphParser';
import {
  findHistoryByUrl,
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
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';
import { errorMessage } from '../utils/errorMessage';

type Props = MainTabScreenProps<'Batch'>;

export const HomeScreen: React.FC<Props> = ({ navigation }) => {
  // Subscribe so all strings re-render in the active language, and resolve
  // colors from the active theme (system-following included).
  useI18n();
  const { isDark: isDarkMode, colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { summary } = useDownload();
  const hasActiveDownload = !summary.finished && summary.total > 0;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<
    import('../types/telegraph').ParseErrorCode | undefined
  >(undefined);
  const [recent, setRecent] = useState<HistoryRecord[]>([]);
  const [pasting, setPasting] = useState(false);
  // Live parser stage so the user sees "Resolving / Fetching / Parsing"
  // feedback while a slow host responds. Null when not parsing.
  const [parseStage, setParseStage] = useState<ParseStage | null>(null);
  // AbortController for the in-flight parse so the cancel button / clear
  // can release the network request immediately.
  const parseAbortRef = useRef<AbortController | null>(null);
  // Guards the async duplicate-check so rapid taps don't stack multiple alerts.
  const parseCheckRef = useRef(false);

  // A stable callback that accepts a shared/clipboard text, extracts the first
  // http(s) URL, and fills the input (but never auto-parses without the user
  // tapping Parse). When `fromClipboard` is set the `autoFillClipboard` setting
  // gates it; explicit share intents are always honoured.
  const applySharedText = useCallback(
    (text: string | null | undefined, opts?: { fromClipboard?: boolean }) => {
      if (!text) return;
      const urls = extractWebUrls(text);
      if (urls.length === 0) return;
      // Defensive URL validation: reject non-http(s), loopback, etc.
      const safe = urls.find(u => validateWebUrl(u) === null);
      if (!safe) return;
      if (opts?.fromClipboard && !getSettingsSync().autoFillClipboard) return;
      // Single-link mode: the input holds exactly one link.
      setInput(safe);
      setErrorCode(undefined);
    },
    [],
  );

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
          const items = await listHistory(10);
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
        applySharedText(text, { fromClipboard: true });
      } catch {
        // Clipboard read can fail on some devices; ignore.
      }
    })();
  }, [applySharedText]);

  const handleClear = useCallback(() => {
    setInput('');
    setErrorCode(undefined);
    setLoading(false);
    setParseStage(null);
    parseAbortRef.current?.abort();
    parseAbortRef.current = null;
  }, []);

  // Paste the last usable URL from the clipboard into the input box. This is
  // an explicit user action (unlike the auto-fill-on-launch), so it always
  // works regardless of the autoFillClipboard setting.
  const handlePaste = useCallback(async () => {
    if (pasting) return;
    setPasting(true);
    try {
      const text = await Clipboard.getString();
      if (!text) {
        Alert.alert(t('home.pasteNoUrl'));
        return;
      }
      const urls = extractWebUrls(text);
      // Single-link mode: refuse to paste when the clipboard holds several
      // links, and ask the user to copy just one.
      if (urls.length > 1) {
        Alert.alert(t('home.pasteMultiple'));
        return;
      }
      const safe = urls[0];
      if (!safe || validateWebUrl(safe) !== null) {
        Alert.alert(t('home.pasteNoUrl'));
        return;
      }
      // Replace the input (single-link mode).
      setInput(safe);
      setErrorCode(undefined);
    } catch {
      Alert.alert(t('home.pasteNoUrl'));
    } finally {
      setPasting(false);
    }
  }, [pasting]);

  const runParse = useCallback(
    async (target: string) => {
      setErrorCode(undefined);
      setLoading(true);
      setParseStage('resolving');
      const ctrl = new AbortController();
      parseAbortRef.current?.abort();
      parseAbortRef.current = ctrl;
      let result;
      try {
        result = await parseArticle(target, {
          signal: ctrl.signal,
          onStage: stage => setParseStage(stage),
        });
      } catch (err) {
        // Most likely AbortError from cancel — surface as a non-error neutral
        // result so the user can re-trigger.
        const name = (err as { name?: string })?.name;
        setLoading(false);
        setParseStage(null);
        if (parseAbortRef.current === ctrl) {
          parseAbortRef.current = null;
        }
        if (name === 'AbortError') return;
        setErrorCode('UNKNOWN');
        return;
      }
      setLoading(false);
      setParseStage(null);
      if (parseAbortRef.current === ctrl) {
        parseAbortRef.current = null;
      }
      if (ctrl.signal.aborted) return;
      if (result.ok && result.article) {
        navigation.navigate('Preview', { article: result.article });
        return;
      }
      setErrorCode(result.error?.code);
    },
    [navigation],
  );

  const handleParse = useCallback(async () => {
    // Single-link mode: parsing only handles one link at a time.
    if (detected.length > 1) {
      Alert.alert(t('home.multipleUrls'));
      return;
    }
    const target = detected[0];
    if (!target) {
      setErrorCode('INVALID_URL');
      return;
    }
    if (parseCheckRef.current) return;
    parseCheckRef.current = true;
    try {
      // Warn before re-parsing an article that already has a history row.
      const existing = await findHistoryByUrl(target);
      if (existing) {
        const proceed = await confirmDialog(
          t('home.duplicateTitle'),
          t('home.duplicateBody'),
          t('home.duplicateContinue'),
          t('home.duplicateCancel'),
        );
        if (!proceed) return;
      }
    } catch {
      // DB lookup failure must not block parsing; fall through.
    } finally {
      parseCheckRef.current = false;
    }
    await runParse(target);
  }, [detected, runParse]);

  const handleCancelParse = useCallback(() => {
    parseAbortRef.current?.abort();
  }, []);

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
          <View style={styles.headerRight}>
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
        </View>
        <UrlInput
          value={input}
          onChange={setInput}
          onSubmit={handleParse}
          onClear={handleClear}
          onPaste={handlePaste}
          loading={loading}
          pasting={pasting}
          containerStyle={styles.urlInputContainer}
        />
        {loading ? (
          <View style={styles.parseProgress}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.parseProgressText}>
              {parseStage ? stageLabel(parseStage) : t('common.loading')}
            </Text>
            <Pressable
              onPress={handleCancelParse}
              hitSlop={8}
              style={({ pressed }) => [
                styles.parseCancelBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.parseCancelText}>
                {t('home.parseCancel')}
              </Text>
            </Pressable>
          </View>
        ) : null}
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

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.background,
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
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    downloadIconBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    downloadIcon: { fontSize: 18, color: c.primary },
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
      color: c.textPrimary,
    },
    subtitle: {
      marginTop: 4,
      fontSize: 13,
      color: c.textSecondary,
    },
    parseProgress: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 4,
    },
    parseProgressText: {
      flex: 1,
      fontSize: 13,
      color: c.textSecondary,
    },
    parseCancelBtn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: c.primarySoft,
    },
    parseCancelText: { color: c.primary, fontSize: 13, fontWeight: '600' },
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
      color: c.textSecondary,
      marginBottom: 8,
    },
    recentCard: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: 10,
      minHeight: 120,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
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
      backgroundColor: c.dangerBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.danger,
    },
    errorText: {
      color: c.danger,
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
      color: c.textHint,
      textDecorationLine: 'underline',
    },
    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    viewAll: {
      fontSize: 12,
      color: c.primary,
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
      borderBottomColor: c.border,
    },
    recentTitle: {
      flex: 1,
      fontSize: 14,
      color: c.textPrimary,
      fontWeight: '500',
    },
    recentCount: {
      marginLeft: 12,
      fontSize: 12,
      color: c.textHint,
      fontVariant: ['tabular-nums'],
    },
  });
}

const RecentRow: React.FC<{
  record: HistoryRecord;
  divider: boolean;
  onPress: () => void;
}> = ({ record, divider, onPress }) => {
  // Subscribe so the item-count string re-renders in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.recentRow,
        divider && styles.recentRowDivider,
        pressed && { backgroundColor: colors.primarySoft },
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

function stageLabel(stage: ParseStage): string {
  switch (stage) {
    case 'resolving':
      return t('home.parseStage.resolving');
    case 'fetching':
      return t('home.parseStage.fetching');
    case 'parsing':
      return t('home.parseStage.parsing');
    default:
      return t('common.loading');
  }
}

/**
 * Promise wrapper around Alert.alert so callers can `await` the user's choice.
 * Resolves true when the confirm button is pressed, false on cancel/dismiss.
 */
function confirmDialog(
  title: string,
  message: string,
  confirmLabel: string,
  cancelLabel: string,
): Promise<boolean> {
  return new Promise(resolve => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
