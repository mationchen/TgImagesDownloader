/**
 * 「补全标签」面板（设置页打开）。
 *
 * 老记录（v7 之前）没有标签，但大多有原始网址，可以按网址回抓页面上的标签。
 * 这个组件只负责界面与进度；真正的抓取/限速/续跑在 `services/tagBackfill.ts`。
 *
 * 界面三态：说明 → 运行中（可停止）→ 结果（可关闭）。
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';
import {
  backfillTags,
  type TagBackfillProgress,
  type TagBackfillResult,
} from '../services/tagBackfill';

export const TagBackfillModal: React.FC<{
  visible: boolean;
  /** 预计要处理的条数（设置页已经查过，避免重复查询）。 */
  missingCount: number;
  onClose: () => void;
  /** 跑完或停止后回调，让设置页刷新「待补条数」。 */
  onFinished: () => void;
}> = ({ visible, missingCount, onClose, onFinished }) => {
  const styles = useThemedStyles(createStyles);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState<TagBackfillProgress | null>(null);
  const [result, setResult] = useState<TagBackfillResult | null>(null);
  const stopRef = useRef(false);

  const start = useCallback(() => {
    stopRef.current = false;
    setPhase('running');
    setResult(null);
    setProgress(null);
    backfillTags({
      onProgress: setProgress,
      shouldStop: () => stopRef.current,
    })
      .then(r => {
        setResult(r);
      })
      .catch(() => {
        // 任务级异常（例如读库失败）：如实显示成「全部失败」，不要假装完成。
        setResult({
          total: missingCount,
          ok: 0,
          empty: 0,
          failed: missingCount,
          stopped: false,
          unreachableHosts: [],
        });
      })
      .finally(() => {
        setPhase('done');
        onFinished();
      });
  }, [missingCount, onFinished]);

  const stop = useCallback(() => {
    stopRef.current = true;
  }, []);

  const close = useCallback(() => {
    // 运行中不允许关闭：要么等它停，要么点「停止」。
    if (phase === 'running') return;
    setPhase('idle');
    setResult(null);
    setProgress(null);
    onClose();
  }, [onClose, phase]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={close}
    >
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.sheet} edges={['bottom']}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('settings.tags.title')}</Text>
            {phase !== 'running' ? (
              <Pressable
                onPress={close}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={t('settings.tags.close')}
              >
                <Text style={styles.close}>×</Text>
              </Pressable>
            ) : null}
          </View>

          {phase === 'idle' ? (
            <>
              <Text style={styles.body}>
                {t('settings.tags.intro', { count: missingCount })}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={close}
                  style={({ pressed }) => [
                    styles.btnGhost,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.btnGhostText}>
                    {t('common.cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={start}
                  disabled={missingCount === 0}
                  style={({ pressed }) => [
                    styles.btnPrimary,
                    missingCount === 0 && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.btnPrimaryText}>
                    {t('settings.tags.start')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {phase === 'running' ? (
            <>
              <View style={styles.runningRow}>
                <ActivityIndicator />
                <Text style={styles.runningText}>
                  {t('settings.tags.running', {
                    done: progress?.done ?? 0,
                    total: progress?.total ?? missingCount,
                  })}
                </Text>
              </View>
              <Text style={styles.stats}>
                {t('settings.tags.stats', {
                  ok: progress?.ok ?? 0,
                  empty: progress?.empty ?? 0,
                  failed: progress?.failed ?? 0,
                })}
              </Text>
              {progress?.currentHost ? (
                <Text style={styles.host} numberOfLines={1}>
                  {progress.currentHost}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  onPress={stop}
                  style={({ pressed }) => [
                    styles.btnDanger,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.btnDangerText}>
                    {t('settings.tags.stop')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {phase === 'done' ? (
            <>
              <Text style={styles.doneTitle}>
                {result?.stopped
                  ? t('settings.tags.stopped')
                  : t('settings.tags.done')}
              </Text>
              <Text style={styles.stats}>
                {t('settings.tags.stats', {
                  ok: result?.ok ?? 0,
                  empty: result?.empty ?? 0,
                  failed: result?.failed ?? 0,
                })}
              </Text>
              {result && result.unreachableHosts.length > 0 ? (
                <Text style={styles.warn}>
                  {t('settings.tags.unreachable', {
                    hosts: result.unreachableHosts.join(', '),
                  })}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  onPress={close}
                  style={({ pressed }) => [
                    styles.btnPrimary,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.btnPrimaryText}>
                    {t('settings.tags.close')}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    title: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    close: { fontSize: 24, lineHeight: 26, color: c.textSecondary },
    body: { fontSize: 13, lineHeight: 20, color: c.textSecondary },
    runningRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 4,
    },
    runningText: { fontSize: 14, color: c.textPrimary, fontWeight: '600' },
    stats: { fontSize: 13, color: c.textSecondary, marginTop: 8 },
    host: { fontSize: 12, color: c.textHint, marginTop: 4 },
    doneTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    warn: { fontSize: 12, color: c.danger, marginTop: 8, lineHeight: 18 },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 10,
      paddingVertical: 14,
    },
    btnPrimary: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.primary,
    },
    btnPrimaryText: {
      color: c.textOnPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    btnGhost: { paddingHorizontal: 14, paddingVertical: 10 },
    btnGhostText: { color: c.textSecondary, fontSize: 14 },
    btnDanger: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.danger,
    },
    btnDangerText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.6 },
  });
