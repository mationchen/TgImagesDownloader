import React, { useCallback, useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DownloadProgress } from '../components/DownloadProgress';
import { DownloadItem } from '../components/DownloadItem';
import { useDownload } from '../store/DownloadContext';
import type { DownloadState } from '../store/downloadReducer';
import { recordHistoryFromState } from '../services/historyService';

import type { RootStackScreenProps } from '../navigation/types';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';

type Props = RootStackScreenProps<'Download'>;

export const DownloadScreen: React.FC<Props> = ({ route, navigation }) => {
  // Subscribe so all strings re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const params = route.params as
    | {
        article: import('../types/telegraph').TelegraphArticle;
        images: import('../types/telegraph').TelegraphImage[];
      }
    | undefined;
  const article = params?.article;
  const images = params?.images;
  const { state, summary, start, pause, resume, cancel, retryFailed } =
    useDownload();

  // Auto-start when launched from Preview with article/images.
  // When opened from Home's download icon (no params), just show existing queue.
  //
  // Deps are `[article, images, start]` (NOT `[]`) so that re-entering the
  // screen via `navigate('Download', {newParams})` — which reuses the same
  // native-stack instance and only updates params — also re-triggers
  // `start()`. Without this, the second download silently shows the previous
  // batch's progress/state because the component is never re-mounted.
  useEffect(() => {
    console.log(
      `[DL] DownloadScreen effect article=${article?.title ?? 'none'} images=${
        images?.length ?? 0
      }`,
    );
    if (article && images && images.length > 0) {
      console.log(`[DL] DownloadScreen start called`);
      start(article, images);
    } else {
      console.log('[DL] DownloadScreen no params, showing existing queue');
    }
  }, [article, images, start]);

  // Persist a history row once the batch reaches a terminal state.
  // Only fires on the transition into `finished`, not on every render.
  //
  // Uses the shared recorder so the Home flow and the batch URL flow
  // (DownloadContext.runDownload) write identical history rows.
  const wroteHistory = React.useRef(false);
  useEffect(() => {
    if (!summary.finished || wroteHistory.current) return;
    // When opened via Home icon without params, article is undefined — the
    // state still carries the article for the current queue.
    const histArticle = article ?? state.article;
    if (!histArticle?.url) return;
    wroteHistory.current = true;
    recordHistoryFromState(state).catch(() => {
      // History persistence is best-effort; never block the UI on it.
    });
  }, [summary, article, state]);

  // Reset the "already wrote" guard whenever a new batch starts.
  useEffect(() => {
    wroteHistory.current = false;
  }, [route.params]);

  useEffect(() => {
    console.log(
      `[DL] summary total=${summary.total} success=${summary.success} failed=${
        summary.failed
      } downloading=${summary.downloading} pending=${
        summary.pending
      } finished=${summary.finished} progress=${summary.progressPercent.toFixed(
        1,
      )}%`,
    );
  }, [summary]);

  const handleClose = useCallback(() => {
    if (!summary.finished) {
      cancel();
    }
    navigation.navigate('Tabs', { screen: 'Batch' });
  }, [summary.finished, cancel, navigation]);

  const handleBack = useCallback(() => {
    // Return to Home without cancelling — download continues in background
    navigation.navigate('Tabs', { screen: 'Batch' });
  }, [navigation]);

  useEffect(() => {
    navigation.setOptions({
      headerTitle: t('download.title'),
      headerTitleAlign: 'center',
      headerRight: () => (
        <Pressable
          onPress={handleClose}
          hitSlop={12}
          style={styles.headerCloseBtn}
        >
          <Text style={styles.headerCloseText}>{t('download.close')}</Text>
        </Pressable>
      ),
    });
  }, [navigation, handleClose, styles]);

  const renderItem = useCallback(
    ({ item }: { item: string }) => {
      const task = state.tasks[item];
      const image = state.article.images.find(i => i.id === item);
      return <DownloadItem task={task} image={image} />;
    },
    [state.tasks, state.article.images],
  );

  const keyExtractor = useCallback((id: string) => id, []);

  const primaryLabel = summary.finished
    ? t('download.done')
    : state.isPaused
    ? '▶'
    : '⏸';

  const onPrimary = summary.finished
    ? () => undefined
    : state.isPaused
    ? resume
    : pause;

  const secondaryLabel = summary.finished
    ? t('download.backToHome')
    : t('download.cancelAll');

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <DownloadProgress state={state} summary={summary} />
      {summary.finished && hasHotlinkFailure(state) ? (
        <View style={styles.hotlinkNotice}>
          <Text style={styles.hotlinkText}>{t('download.hotlinkExplain')}</Text>
        </View>
      ) : null}
      <FlatList
        data={state.taskOrder}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        removeClippedSubviews
        initialNumToRender={30}
        windowSize={7}
        maxToRenderPerBatch={30}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t('download.noTasks')}</Text>
          </View>
        }
      />
      <View style={styles.footer}>
        {summary.failed > 0 && summary.finished ? (
          <Pressable
            onPress={retryFailed}
            style={({ pressed }) => [
              styles.retryBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.retryText}>
              {t('download.retryFailed', { count: summary.failed })}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onPrimary}
          disabled={summary.finished}
          style={({ pressed }) => [
            styles.primaryBtn,
            state.isPaused ? styles.resumeBtn : styles.pauseBtn,
            summary.finished && styles.disabled,
            pressed && !summary.finished && styles.pressed,
          ]}
        >
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
        <Pressable
          onPress={handleBack}
          style={({ pressed }) => [
            styles.secondaryBtn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.secondaryText}>{secondaryLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

function hasHotlinkFailure(state: DownloadState): boolean {
  for (const id of state.taskOrder) {
    const task = state.tasks[id];
    if (
      task &&
      task.status === 'failed' &&
      /ERR_HOTLINK_BLOCKED|ERR_BLOCKED_HOST/.test(task.error ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    list: {
      paddingVertical: 4,
    },
    empty: {
      padding: 24,
      alignItems: 'center',
    },
    emptyText: {
      color: c.textHint,
      fontSize: 13,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      backgroundColor: c.background,
      gap: 8,
    },
    primaryBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
    },
    pauseBtn: { backgroundColor: c.warning },
    resumeBtn: { backgroundColor: c.primary },
    primaryText: {
      color: c.textOnPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    retryBtn: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: c.success,
      alignItems: 'center',
    },
    retryText: {
      color: c.textOnPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    secondaryBtn: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    secondaryText: {
      color: c.textSecondary,
      fontSize: 13,
      fontWeight: '500',
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.75,
    },
    headerCloseBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: c.primary,
      borderRadius: 6,
      marginRight: 4,
    },
    headerCloseText: {
      color: c.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    hotlinkNotice: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: c.warningBg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.warning,
    },
    hotlinkText: {
      color: c.textPrimary,
      fontSize: 12,
      lineHeight: 17,
    },
  });
}
