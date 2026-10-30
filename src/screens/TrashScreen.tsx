import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
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
  TRASH_CAPACITY,
  type HistoryRecord,
} from '../services/historyService';
import {
  TelegraphDownloader,
  isDownloaderAvailable,
  isVideoUri,
} from '../services/nativeDownloader';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { formatLocalDateTime } from '../utils/time';
import type { RootStackScreenProps } from '../navigation/types';

type Props = RootStackScreenProps<'Trash'>;

/**
 * 回收站。
 *
 * 「下载记录」里被标记为删除、再点「移入回收站」的记录会到这里；它们不再出现在
 * 下载记录列表里，但数据和图片都还在。这里可以：
 *   - 点进详情页再确认一遍（查看图片、长按操作）
 *   - 单条恢复（回到下载记录）
 *   - 一键清空：删记录 + 删相册文件（不可撤销）
 *
 * 容量上限见 {@link TRASH_CAPACITY}：满了之后不再接收新的记录。
 */
export const TrashScreen: React.FC<Props> = ({ navigation }) => {
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
          {/* 空的时候也要说清容量规则，否则用户不知道「满 500 条就进不来」 */}
          <Text style={styles.emptyCapacity}>
            {t('trash.capacity', { count: 0, capacity: TRASH_CAPACITY })}
          </Text>
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
          {/* 容量说明：满了之后下载记录那边会拒绝继续移入 */}
          <Text
            style={[
              styles.capacityHint,
              count >= TRASH_CAPACITY && styles.capacityHintFull,
            ]}
          >
            {t('trash.capacity', { count, capacity: TRASH_CAPACITY })}
          </Text>
          <FlatList
            data={records}
            keyExtractor={item => String(item.id)}
            contentContainerStyle={styles.list}
            // 缩略图 + 长列表：只挂可视区附近的几屏，避免一次解码几百张图
            // （不要加 removeClippedSubviews —— Fabric 下会 addViewAt 越界崩溃）
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
            renderItem={({ item }) => (
              <TrashRow
                record={item}
                onPress={() =>
                  navigation.navigate('HistoryDetail', {
                    id: item.id,
                    ids: records.map(r => r.id),
                  })
                }
                onRestore={() => onRestore(item)}
              />
            )}
          />
        </>
      )}
    </SafeAreaView>
  );
};

/**
 * 回收站里的一行：缩略图 + 标题 + 移入时间 + 恢复按钮。
 * 整行点进详情页（会带着回收站的 id 列表，可以左右滑动相邻记录）。
 */
const TrashRow: React.FC<{
  record: HistoryRecord;
  onPress: () => void;
  onRestore: () => void;
}> = React.memo(({ record, onPress, onRestore }) => {
  useI18n();
  const styles = useThemedStyles(createStyles);
  // 与下载记录列表一致：本地打不开时退到远程，两张都失败才显示占位。
  const localPreview = record.imagePaths?.[0] ?? null;
  const remotePreview = record.imageUrls?.[0] ?? null;
  const [previewPhase, setPreviewPhase] = useState<'local' | 'remote' | 'failed'>(
    'local',
  );
  const previewUri =
    previewPhase === 'remote' && remotePreview
      ? remotePreview
      : localPreview ?? remotePreview;
  const previewIsVideo = previewUri ? isVideoUri(previewUri) : false;
  const showPreview =
    !!previewUri && !previewIsVideo && previewPhase !== 'failed';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={t('trash.openHint')}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {showPreview ? (
        <Image
          source={{ uri: previewUri }}
          style={styles.rowThumb}
          resizeMode="cover"
          onError={() => {
            if (previewPhase === 'local' && remotePreview && localPreview) {
              setPreviewPhase('remote');
            } else {
              setPreviewPhase('failed');
            }
          }}
        />
      ) : (
        <View style={[styles.rowThumb, styles.rowThumbEmpty]}>
          <Text style={styles.rowThumbIcon}>
            {previewIsVideo ? '🎬' : '🖼'}
          </Text>
        </View>
      )}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {decodeHtmlEntities(record.title)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {t('history.itemCount', { count: record.imageCount })} ·{' '}
          {t('trash.trashedAt', {
            time: formatLocalDateTime(record.trashedAt),
          })}
        </Text>
      </View>
      <Pressable
        onPress={onRestore}
        accessibilityRole="button"
        accessibilityLabel={t('trash.restoreHint')}
        hitSlop={6}
        style={({ pressed }) => [styles.restoreBtn, pressed && styles.pressed]}
      >
        <Text style={styles.restoreBtnText}>{t('trash.restore')}</Text>
      </Pressable>
    </Pressable>
  );
});
TrashRow.displayName = 'TrashRow';

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
    emptyCapacity: {
      marginTop: 4,
      fontSize: 12,
      color: c.textHint,
      textAlign: 'center',
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
    capacityHint: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      fontSize: 12,
      color: c.textHint,
      backgroundColor: c.surface,
    },
    capacityHintFull: { color: c.danger, fontWeight: '600' },
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
    rowThumb: {
      width: 56,
      height: 56,
      borderRadius: 8,
      backgroundColor: c.surface,
    },
    rowThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
    rowThumbIcon: { fontSize: 22 },
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
