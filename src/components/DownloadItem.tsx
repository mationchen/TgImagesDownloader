import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {DownloadTask, DownloadStatus} from '../types/download';
import type {TelegraphImage} from '../types/telegraph';
import {t} from '../i18n';

type Props = {
  task: DownloadTask;
  image: TelegraphImage | undefined;
};

export const DownloadItem: React.FC<Props> = React.memo(({task, image}) => {
  const isHotlink = /ERR_HOTLINK_BLOCKED/.test(task.error ?? '');
  const {label, icon, color} = describe(task.status, task.progress, isHotlink);
  return (
    <View style={styles.row}>
      <Text style={styles.filename} numberOfLines={1}>
        {image?.filename ?? `task-${task.id.slice(0, 6)}`}
      </Text>
      <View style={styles.right}>
        <Text style={[styles.statusText, {color}]}>{icon}</Text>
        <Text
          style={[styles.statusLabel, {color}]}
          numberOfLines={1}
          ellipsizeMode="tail">
          {label}
        </Text>
      </View>
    </View>
  );
});
DownloadItem.displayName = 'DownloadItem';

function describe(
  status: DownloadStatus,
  progress: number,
  isHotlink: boolean,
): {label: string; icon: string; color: string} {
  switch (status) {
    case 'success':
      return {label: t('download.itemSuccess'), icon: '✓', color: '#1b7a3a'};
    case 'failed':
      if (isHotlink) {
        return {label: t('download.itemHotlink'), icon: '✕', color: '#b8860b'};
      }
      return {label: t('download.itemFailed'), icon: '✕', color: '#a32'};
    case 'skipped':
      return {label: t('download.itemSkipped'), icon: '⤼', color: '#888'};
    case 'cancelled':
      return {label: t('download.itemCancelled'), icon: '∥', color: '#666'};
    case 'paused':
      return {label: t('download.itemPaused'), icon: '‖', color: '#666'};
    case 'downloading':
      return {
        label: t('download.itemProgress', {percent: Math.round(progress)}),
        icon: '↓',
        color: '#1976d2',
      };
    case 'pending':
    default:
      return {label: t('download.itemWaiting'), icon: '·', color: '#999'};
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  filename: {
    flex: 1,
    fontSize: 13,
    color: '#222',
    fontVariant: ['tabular-nums'],
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 92,
    justifyContent: 'flex-end',
  },
  statusText: {
    fontSize: 14,
    fontWeight: '700',
    marginRight: 6,
    width: 14,
    textAlign: 'center',
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
});