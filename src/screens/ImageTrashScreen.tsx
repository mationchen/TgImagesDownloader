import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ScrollViewInstance, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { ZoomableImage } from '../components/ZoomableImage';
import { listTrashedImages, restoreTrashedImage, type TrashedImage } from '../services/historyService';
import { purgeTrashedImages } from '../services/imageTrashService';
import { useMediaReadPermission } from '../utils/mediaPermission';
import { decodeHtmlEntities } from '../utils/htmlEntities';
import { formatLocalDateTime } from '../utils/time';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';

export const ImageTrashScreen: React.FC = () => {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const mediaTick = useMediaReadPermission();
  const [items, setItems] = useState<TrashedImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [index, setIndex] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const load = useCallback(async () => {
    try { setItems(await listTrashedImages()); setError(false); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load().catch(() => undefined); }, [load]));
  const rows = useMemo(() => {
    const result: { start: number; cells: TrashedImage[] }[] = [];
    for (let i = 0; i < items.length; i += 3) result.push({ start: i, cells: items.slice(i, i + 3) });
    return result;
  }, [items]);
  const restore = async (uri: string) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setIndex(null);
    try { await restoreTrashedImage(uri); await load(); }
    catch (err) {
      Alert.alert(err instanceof Error && err.message === 'IMAGE_TRASH_RECORD_MISSING'
        ? t('imageTrash.restoreMissing') : t('imageTrash.error'));
    }
    finally { locked.current = false; setBusy(false); }
  };
  const clear = () => {
    if (locked.current || !items.length) return;
    const snapshot = items.slice();
    Alert.alert(t('imageTrash.clear'), t('imageTrash.clearConfirm', { count: snapshot.length }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('imageTrash.clear'), style: 'destructive', onPress: async () => {
        if (locked.current) return;
        locked.current = true; setBusy(true); setIndex(null);
        try {
          const result = await purgeTrashedImages(snapshot);
          await load();
          Alert.alert(t('imageTrash.clear'), t('imageTrash.clearResult', result));
        } catch { Alert.alert(t('imageTrash.error')); }
        finally { locked.current = false; setBusy(false); }
      } },
    ]);
  };
  const size = Math.floor((width - 8) / 3);
  const current = index == null ? undefined : items[index];
  const onViewerScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setZoomed(false);
    setIndex(Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.x / width))));
  };
  return (
    <SafeAreaView style={styles.root} edges={['left', 'right', 'bottom']}>
      <View style={styles.bar}>
        <Text style={styles.text}>{t('imageTrash.count', { count: items.length })}</Text>
        <Pressable onPress={clear} disabled={busy || !items.length} style={styles.button}><Text style={styles.link}>{busy ? t('common.loading') : t('imageTrash.clear')}</Text></Pressable>
      </View>
      <Text style={styles.hint}>{t('imageTrash.hint')}</Text>
      {loading ? <ActivityIndicator /> : error ? (
        <Pressable onPress={load} style={styles.button}><Text style={styles.link}>{t('imageTrash.error')} · {t('common.retry')}</Text></Pressable>
      ) : <FlatList
        data={rows} keyExtractor={row => String(row.start)}
        initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
        ListEmptyComponent={<Text style={styles.hint}>{t('imageTrash.empty')}</Text>}
        renderItem={({ item: row }) => <View style={styles.row}>{row.cells.map((item, k) => (
          <View key={item.uri} style={[styles.tile, { width: size }]}>
            <Pressable disabled={busy} onPress={() => { setZoomed(false); setIndex(row.start + k); }} accessibilityRole="imagebutton" accessibilityLabel={t('imageTrash.imageNumber', { number: row.start + k + 1 })}>
              <Image key={`${mediaTick}-${item.uri}`} source={{ uri: item.uri }} resizeMode="cover" resizeMethod="resize" style={{ width: size, height: size * 4 / 3, backgroundColor: styles.tile.backgroundColor }} />
            </Pressable>
            <Pressable disabled={busy} onPress={() => restore(item.uri)} style={styles.button}><Text style={styles.link}>{t('imageTrash.restore')}</Text></Pressable>
          </View>
        ))}</View>}
      />}
      {current && index != null ? (
        <Modal visible onRequestClose={() => setIndex(null)} animationType="fade" statusBarTranslucent>
          <SafeAreaView style={styles.viewer}>
            <View style={styles.bar}>
              <Pressable style={styles.button} onPress={() => setIndex(null)}><Text style={styles.white}>{t('common.close')}</Text></Pressable>
              <Text style={styles.white}>{t('preview.viewerIndex', { current: index + 1, total: items.length })}</Text>
              <Pressable style={styles.button} onPress={() => restore(current.uri)}><Text style={styles.white}>{t('imageTrash.restore')}</Text></Pressable>
            </View>
            <ScrollView ref={scroll} horizontal pagingEnabled scrollEnabled={!zoomed} style={styles.scroll}
              onLayout={() => scroll.current?.scrollTo({ x: index * width, animated: false })}
              onContentSizeChange={() => scroll.current?.scrollTo({ x: index * width, animated: false })}
              onMomentumScrollEnd={onViewerScrollEnd}
              onScrollEndDrag={onViewerScrollEnd}
              showsHorizontalScrollIndicator={false}>
              {items.map((item, i) => <View key={item.uri} style={[styles.viewerPage, { width }]}>
                {Math.abs(i - index) <= 2 ? <View style={styles.inner}><TrashViewerImage uri={item.uri} onZoomChange={setZoomed} /></View> : null}
              </View>)}
            </ScrollView>
            <Text style={[styles.hint, styles.white]} numberOfLines={2}>{decodeHtmlEntities(current.title)}</Text>
            <Text style={[styles.hint, styles.white]}>{t('trash.trashedAt', { time: formatLocalDateTime(current.trashedAt) })}</Text>
          </SafeAreaView>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
};

const TrashViewerImage: React.FC<{ uri: string; onZoomChange: (zoomed: boolean) => void }> = ({ uri, onZoomChange }) => {
  const [failed, setFailed] = useState(false);
  const styles = useThemedStyles(createStyles);
  // Never fall back to a different remote image: this screen verifies the exact recycled file.
  return failed ? <Text style={[styles.hint, styles.white]}>{t('preview.imageLoadFailed')}</Text>
    : <ZoomableImage uri={uri} onZoomChange={onZoomChange} onError={() => setFailed(true)} />;
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12 },
    row: { flexDirection: 'row' }, button: { padding: 12, alignItems: 'center' },
    text: { color: c.textPrimary }, link: { color: c.primary }, hint: { color: c.textHint, padding: 12 },
    tile: { margin: 1, backgroundColor: c.surfaceStrong }, viewer: { flex: 1, backgroundColor: '#000' },
    viewerPage: { height: '100%' },
    white: { color: '#fff' }, scroll: { flex: 1 }, inner: { flex: 1, width: '100%' },
  });
}
