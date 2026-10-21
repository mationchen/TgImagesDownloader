import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { EmptyState } from '../components/EmptyState';
import {
  initHistoryDatabase,
  listTrash,
  purgeHistory,
  recordImageUris,
  removeDownloadedImages,
  restoreFromTrash,
  type HistoryRecord,
} from '../services/historyService';
import {
  TelegraphDownloader,
  isDownloaderAvailable,
} from '../services/nativeDownloader';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { formatLocalDateTime } from '../utils/time';

/**
 * 回收站。
 *
 * 「下载记录」里被标记为删除、再点「移入回收站」的记录会到这里；它们不再出现在
 * 下载记录列表里，但数据和图片都还在。这里可以：
 *   - 单条恢复（回到下载记录）
 *   - 一键清空：删记录 + 删相册文件（不可撤销）
 */
export const TrashScreen: React.FC = () => {
  useI18n();
  const styles = useThemedStyles(createStyles);

  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      await initHistoryDatabase();
      setRecords(await listTrash(500));
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次回到本页都重新读一次（在详情页恢复/删除后不会有残留）。
  useFocusEffect(
    useCallback(() => {
      load().catch(() => undefined);
    }, [load]),
  );

  /** 单条恢复。 */
  const onRestore = useCallback(
    (record: HistoryRecord) => {
      restoreFromTrash(record.id)
        .then(async () => {
          ToastAndroid.show(t('trash.restore'), ToastAndroid.SHORT);
          await load({ silent: true });
        })
        .catch(() => undefined);
    },
    [load],
  );

  /** 一键清空：删记录 + 连带删除相册文件 + 清掉台账，避免下次下载被误跳过。 */
  const onClear = useCallback(() => {
    if (records.length === 0 || busy) return;
    const images = records.reduce(
      (sum, r) => sum + recordImageUris(r).length,
      0,
    );
    Alert.alert(
      t('trash.clearTitle'),
      t('trash.clearMsg', { count: records.length, images }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('trash.clear'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            (async () => {
              try {
                const uris = records.flatMap(recordImageUris);
                if (
                  uris.length > 0 &&
                  isDownloaderAvailable() &&
                  TelegraphDownloader?.deleteGalleryImages
                ) {
                  await TelegraphDownloader.deleteGalleryImages(uris);
                }
                const ledgerKeys = records.flatMap(r => r.imageUrls ?? []);
                if (ledgerKeys.length > 0) {
                  await removeDownloadedImages(ledgerKeys);
                }
                await purgeHistory(records.map(r => r.id));
                ToastAndroid.show(
                  t('trash.clearDone', { count: records.length }),
                  ToastAndroid.SHORT,
                );
                await load({ silent: true });
              } catch {
                // 失败就保持原样，用户可以重试
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [records, busy, load]);

  const count = records.length;

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : count === 0 ? (
        <View style={styles.center}>
          <EmptyState title={t('trash.empty')} />
          <Text style={styles.emptyHint}>{t('trash.emptyHint')}</Text>
        </View>
      ) : (
        <>
          <View style={styles.toolbar}>
            <Text style={styles.countText}>
              {t('settings.trash.count', { count })}
            </Text>
            <Pressable
              onPress={onClear}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.clearBtn,
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.clearBtnText}>
                {busy ? t('common.loading') : `🗑 ${t('trash.clear')}`}
              </Text>
            </Pressable>
          </View>
          <FlatList
            data={records}
            keyExtractor={item => String(item.id)}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {decodeHtmlEntities(item.title)}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {t('history.itemCount', { count: item.imageCount })} ·{' '}
                    {t('trash.trashedAt', {
                      time: formatLocalDateTime(item.trashedAt),
                    })}
                  </Text>
                </View>
                <Pressable
                  onPress={() => onRestore(item)}
                  accessibilityRole="button"
                  accessibilityLabel={t('trash.restoreHint')}
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.restoreBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.restoreBtnText}>
                    {t('trash.restore')}
                  </Text>
                </Pressable>
              </View>
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
};

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 10,
    },
    emptyHint: {
      fontSize: 12.5,
      color: c.textHint,
      textAlign: 'center',
      lineHeight: 19,
    },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 12,
    },
    countText: { fontSize: 13, color: c.textSecondary },
    clearBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: c.dangerBg,
    },
    clearBtnText: { fontSize: 13, color: c.danger, fontWeight: '600' },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.6 },
    list: { paddingBottom: 24 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 12,
    },
    rowMain: { flex: 1 },
    rowTitle: { fontSize: 14.5, color: c.textPrimary, fontWeight: '500' },
    rowMeta: { marginTop: 4, fontSize: 12, color: c.textHint },
    restoreBtn: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 8,
      backgroundColor: c.primarySoft,
    },
    restoreBtnText: {
      fontSize: 12.5,
      color: c.primarySoftText,
      fontWeight: '600',
    },
  });
