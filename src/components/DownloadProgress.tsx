import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import type {DownloadState} from '../store/downloadReducer';
import {t} from '../i18n';

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

export const DownloadProgress: React.FC<Props> = ({state, summary}) => {
  const finishedCount = summary.success + summary.skipped + summary.failed + summary.cancelled;
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
            {width: `${Math.round(summary.progressPercent)}%`},
            summary.finished && styles.barInnerDone,
          ]}
        />
      </View>
      <View style={styles.statsRow}>
        <Stat label={t('download.success')} value={summary.success} tone="ok" />
        <Stat label={t('download.failed')} value={summary.failed} tone="err" />
        <Stat label={t('download.skipped')} value={summary.skipped} tone="muted" />
      </View>
      {state.isPaused ? <Text style={styles.pausedHint}>{subtitle}</Text> : null}
      {!summary.finished && summary.downloading > 0 ? (
        <View style={styles.spinnerRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.spinnerText}>
            {t('download.activeCount', {count: summary.downloading})}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

type StatTone = 'ok' | 'err' | 'muted';
const Stat: React.FC<{label: string; value: number; tone: StatTone}> = ({
  label,
  value,
  tone,
}) => {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone === 'ok' && styles.statOk, tone === 'err' && styles.statErr]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#f6f8fa',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  heading: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
  },
  counter: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1976d2',
    fontVariant: ['tabular-nums'],
  },
  barOuter: {
    height: 6,
    backgroundColor: '#e6e9ed',
    borderRadius: 3,
    marginTop: 10,
    overflow: 'hidden',
  },
  barInner: {
    height: '100%',
    backgroundColor: '#1976d2',
  },
  barInnerDone: {
    backgroundColor: '#1b7a3a',
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
    color: '#444',
    fontVariant: ['tabular-nums'],
  },
  statOk: {color: '#1b7a3a'},
  statErr: {color: '#a32'},
  statLabel: {
    fontSize: 11,
    color: '#888',
  },
  pausedHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#a32',
  },
  spinnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  spinnerText: {
    marginLeft: 8,
    fontSize: 12,
    color: '#666',
  },
});