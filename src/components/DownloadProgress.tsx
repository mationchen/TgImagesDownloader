import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { DownloadState } from '../store/downloadReducer';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';

type Props = {
  state: DownloadState;
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    pending: number;
    downloading: number;
    paused: number;
    cancelled: number;
    finished: boolean;
    progressPercent: number;
  };
};

export const DownloadProgress: React.FC<Props> = ({ state, summary }) => {
  // Subscribe so the component re-renders with fresh strings on locale change.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const finishedCount =
    summary.success + summary.skipped + summary.failed + summary.cancelled;
  const counter = `${finishedCount} / ${summary.total}`;
  const subtitle = state.isPaused ? t('download.paused') : null;

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Text style={styles.heading}>
          {summary.finished ? t('download.done') : t('download.downloading')}
        </Text>
        <Text style={styles.counter}>{counter}</Text>
      </View>
      <View style={styles.barOuter}>
        <View
          style={[
            styles.barInner,
            { width: `${Math.round(summary.progressPercent)}%` },
            summary.finished && styles.barInnerDone,
          ]}
        />
      </View>
      <View style={styles.statsRow}>
        <Stat label={t('download.success')} value={summary.success} tone="ok" />
        <Stat label={t('download.failed')} value={summary.failed} tone="err" />
        <Stat
          label={t('download.skipped')}
          value={summary.skipped}
          tone="muted"
        />
      </View>
      {state.isPaused ? (
        <Text style={styles.pausedHint}>{subtitle}</Text>
      ) : null}
      {!summary.finished && summary.downloading > 0 ? (
        <View style={styles.spinnerRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.spinnerText}>
            {t('download.activeCount', { count: summary.downloading })}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

type StatTone = 'ok' | 'err' | 'muted';
const Stat: React.FC<{ label: string; value: number; tone: StatTone }> = ({
  label,
  value,
  tone,
}) => {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.stat}>
      <Text
        style={[
          styles.statValue,
          tone === 'ok' && styles.statOk,
          tone === 'err' && styles.statErr,
        ]}
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    heading: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    counter: {
      fontSize: 16,
      fontWeight: '600',
      color: c.primary,
      fontVariant: ['tabular-nums'],
    },
    barOuter: {
      height: 6,
      backgroundColor: c.surfaceStrong,
      borderRadius: 3,
      marginTop: 10,
      overflow: 'hidden',
    },
    barInner: {
      height: '100%',
      backgroundColor: c.primary,
    },
    barInnerDone: {
      backgroundColor: c.success,
    },
    statsRow: {
      flexDirection: 'row',
      marginTop: 10,
    },
    stat: {
      marginRight: 24,
    },
    statValue: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    statOk: { color: c.success },
    statErr: { color: c.danger },
    statLabel: {
      fontSize: 11,
      color: c.textHint,
    },
    pausedHint: {
      marginTop: 8,
      fontSize: 12,
      color: c.danger,
    },
    spinnerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
    },
    spinnerText: {
      marginLeft: 8,
      fontSize: 12,
      color: c.textSecondary,
    },
  });
}
