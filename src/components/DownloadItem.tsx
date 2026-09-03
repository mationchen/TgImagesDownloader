import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DownloadTask, DownloadStatus } from '../types/download';
import type { TelegraphImage } from '../types/telegraph';
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';

type Props = {
  task: DownloadTask;
  image: TelegraphImage | undefined;
};

export const DownloadItem: React.FC<Props> = React.memo(({ task, image }) => {
  // Subscribe so labels/percent strings re-render in the active language,
  // and resolve all colors from the active theme.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const isBlocked = /ERR_HOTLINK_BLOCKED|ERR_BLOCKED_HOST/.test(
    task.error ?? '',
  );
  const { label, icon, color } = describe(
    task.status,
    task.progress,
    isBlocked,
    colors,
  );
  return (
    <View style={styles.row}>
      <Text style={styles.filename} numberOfLines={1}>
        {image?.filename ?? `task-${task.id.slice(0, 6)}`}
      </Text>
      <View style={styles.right}>
        <Text style={[styles.statusText, { color }]}>{icon}</Text>
        <Text
          style={[styles.statusLabel, { color }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
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
  isBlocked: boolean,
  c: ThemeColors,
): { label: string; icon: string; color: string } {
  switch (status) {
    case 'success':
      return { label: t('download.itemSuccess'), icon: '✓', color: c.success };
    case 'failed':
      if (isBlocked) {
        return {
          label: t('download.itemHotlink'),
          icon: '✕',
          color: c.warning,
        };
      }
      return { label: t('download.itemFailed'), icon: '✕', color: c.danger };
    case 'skipped':
      return { label: t('download.itemSkipped'), icon: '⤼', color: c.textHint };
    case 'cancelled':
      return {
        label: t('download.itemCancelled'),
        icon: '∥',
        color: c.textSecondary,
      };
    case 'paused':
      return {
        label: t('download.itemPaused'),
        icon: '‖',
        color: c.textSecondary,
      };
    case 'downloading':
      return {
        label: t('download.itemProgress', { percent: Math.round(progress) }),
        icon: '↓',
        color: c.primary,
      };
    case 'pending':
    default:
      return { label: t('download.itemWaiting'), icon: '·', color: c.textHint };
  }
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.background,
    },
    filename: {
      flex: 1,
      fontSize: 13,
      color: c.textPrimary,
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
}
