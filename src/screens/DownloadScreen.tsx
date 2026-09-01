import React, {useCallback, useEffect} from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {DownloadProgress} from '../components/DownloadProgress';
import {DownloadItem} from '../components/DownloadItem';
import {useDownload} from '../store/DownloadContext';
import type {DownloadState} from '../store/downloadReducer';
import {upsertHistory, type HistoryStatus} from '../services/historyService';
import {sanitizeFilename} from '../utils/filename';
import type {RootStackScreenProps} from '../navigation/types';
import {t} from '../i18n';

type Props = RootStackScreenProps<'Download'>;

export const DownloadScreen: React.FC<Props> = ({route, navigation}) => {
  const {article, images} = route.params;
  const {
    state,
    summary,
    start,
    pause,
    resume,
    cancel,
    retryFailed,
  } = useDownload();

  // Auto-start on mount so the user lands on a screen that's already
  // doing work. If they navigated back here via a retry, `start` is called
  // again with the new (failed) image set.
  useEffect(() => {
    start(article, images);
    // We intentionally only run this once per (article,images) identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist a history row once the batch reaches a terminal state.
  // Only fires on the transition into `finished`, not on every render.
  const wroteHistory = React.useRef(false);
  useEffect(() => {
    if (!summary.finished || wroteHistory.current) return;
    wroteHistory.current = true;
    const saveDir = `Pictures/TelegraphDownloader/${
      sanitizeFilename(article.title, 80) || 'untitled'
    }`;
    upsertHistory({
      url: article.url,
      title: article.title,
      imageCount: summary.total,
      successCount: summary.success,
      failedCount: summary.failed,
      skippedCount: summary.skipped,
      saveDir,
      status: deriveStatus(summary.failed, summary.total),
    }).catch(() => {
      // History persistence is best-effort; never block the UI on it.
    });
  }, [summary, article]);

  // Reset the "already wrote" guard whenever a new batch starts.
  useEffect(() => {
    wroteHistory.current = false;
  }, [route.params]);

  function deriveStatus(failed: number, total: number): HistoryStatus {
    if (failed === 0) return 'done';
    if (failed === total) return 'failed';
    return 'partial';
  }

  const handleBack = useCallback(() => {
    if (!summary.finished) {
      cancel();
    }
    navigation.navigate('Home');
  }, [summary.finished, cancel, navigation]);

  useEffect(() => {
    navigation.setOptions({
      headerTitle: t('download.title'),
      headerBackVisible: false,
      headerLeft: headerLeftFactory(handleBack),
    });
  }, [navigation, handleBack]);

  const renderItem = useCallback(
    ({item}: {item: string}) => {
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
    ? t('download.resume')
    : t('download.pause');

  const onPrimary = summary.finished
    ? () => undefined
    : state.isPaused
    ? resume
    : pause;

  const secondaryLabel = summary.finished
    ? t('download.backToHome')
    : t('download.cancelAll');

function headerLeftFactory(onPress: () => void) {
  // eslint-disable-next-line react/no-unstable-nested-components
  return function HeaderBack() {
    return (
      <Pressable onPress={onPress} hitSlop={12}>
        <Text style={styles.headerBack}>{t('download.close')}</Text>
      </Pressable>
    );
  };
}

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
            style={({pressed}) => [
              styles.retryBtn,
              pressed && styles.pressed,
            ]}>
            <Text style={styles.retryText}>
              {t('download.retryFailed', {count: summary.failed})}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onPrimary}
          disabled={summary.finished}
          style={({pressed}) => [
            styles.primaryBtn,
            state.isPaused ? styles.resumeBtn : styles.pauseBtn,
            summary.finished && styles.disabled,
            pressed && !summary.finished && styles.pressed,
          ]}>
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
        <Pressable
          onPress={handleBack}
          style={({pressed}) => [styles.secondaryBtn, pressed && styles.pressed]}>
          <Text style={styles.secondaryText}>{secondaryLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

function hasHotlinkFailure(state: DownloadState): boolean {
  for (const id of state.taskOrder) {
    const task = state.tasks[id];
    if (task && task.status === 'failed' && /ERR_HOTLINK_BLOCKED/.test(task.error ?? '')) {
      return true;
    }
  }
  return false;
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  list: {
    paddingVertical: 4,
  },
  empty: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    color: '#888',
    fontSize: 13,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e5e5',
    backgroundColor: '#fff',
    gap: 8,
  },
  primaryBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  pauseBtn: {backgroundColor: '#f0a020'},
  resumeBtn: {backgroundColor: '#1976d2'},
  primaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#1b7a3a',
    alignItems: 'center',
  },
  retryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#dcdcdc',
  },
  secondaryText: {
    color: '#444',
    fontSize: 13,
    fontWeight: '500',
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
  headerBack: {
    color: '#1976d2',
    fontSize: 15,
    fontWeight: '500',
  },
  hotlinkNotice: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff7e0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0d48a',
  },
  hotlinkText: {
    color: '#8a6d1a',
    fontSize: 12,
    lineHeight: 17,
  },
});