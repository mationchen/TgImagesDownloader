import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';

export const ImageSelectionModal: React.FC<{
  uris: string[];
  onClose: () => void;
  onMove: (uris: string[]) => Promise<void>;
}> = ({ uris, onClose, onMove }) => {
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const size = Math.floor((width - 8) / 3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => {
    const result: { start: number; cells: string[] }[] = [];
    for (let i = 0; i < uris.length; i += 3) result.push({ start: i, cells: uris.slice(i, i + 3) });
    return result;
  }, [uris]);
  const confirm = () => {
    if (!selected.size || busy) return;
    Alert.alert(t('imageTrash.move'), t('imageTrash.moveConfirm', { count: selected.size }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('imageTrash.move'), onPress: async () => {
        setBusy(true);
        try { await onMove([...selected]); onClose(); }
        catch { Alert.alert(t('imageTrash.error')); }
        finally { setBusy(false); }
      } },
    ]);
  };
  return (
    <Modal visible onRequestClose={() => { if (!busy) onClose(); }} animationType="slide">
      <SafeAreaView style={styles.root}>
        <View style={styles.bar}>
          <Text style={styles.title}>{t('imageTrash.select')}</Text>
          <Pressable disabled={busy} onPress={onClose} style={styles.button}><Text style={styles.link}>{t('common.cancel')}</Text></Pressable>
        </View>
        <Text style={styles.hint}>{t('imageTrash.selectionCount', { selected: selected.size, total: uris.length })}</Text>
        <View style={styles.bar}>
          <Pressable disabled={busy} style={styles.button} onPress={() => setSelected(new Set(uris))}><Text style={styles.link}>{t('preview.selectAll')}</Text></Pressable>
          <Pressable disabled={busy} style={styles.button} onPress={() => setSelected(new Set())}><Text style={styles.link}>{t('preview.deselectAll')}</Text></Pressable>
          <Pressable disabled={busy} style={styles.button} onPress={() => setSelected(new Set(uris.filter(uri => !selected.has(uri))))}><Text style={styles.link}>{t('preview.invertSelection')}</Text></Pressable>
        </View>
        <FlatList
          data={rows} extraData={selected} keyExtractor={row => String(row.start)}
          initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
          renderItem={({ item }) => <View style={styles.row}>{item.cells.map((uri, i) => (
            <Pressable key={uri} disabled={busy} accessibilityRole="checkbox"
              accessibilityLabel={t('imageTrash.imageNumber', { number: item.start + i + 1 })}
              accessibilityState={{ checked: selected.has(uri) }}
              onPress={() => setSelected(prev => { const next = new Set(prev); if (next.has(uri)) next.delete(uri); else next.add(uri); return next; })}
              style={[styles.tile, { width: size, height: size * 4 / 3 }, selected.has(uri) && styles.selected]}>
              <Image source={{ uri }} style={styles.image} resizeMode="cover" resizeMethod="resize" />
              <Text style={styles.badge}>{item.start + i + 1}{selected.has(uri) ? ' ✓' : ' ○'}</Text>
            </Pressable>
          ))}</View>}
        />
        <Pressable disabled={busy || !selected.size} onPress={confirm} style={[styles.button, styles.move, (busy || !selected.size) && styles.disabled]}>
          <Text style={styles.link}>{busy ? t('common.loading') : t('imageTrash.move')}</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
    title: { color: c.textPrimary, fontSize: 18, fontWeight: '600' },
    hint: { color: c.textHint, padding: 12 },
    button: { padding: 12 }, link: { color: c.primary, fontSize: 14 },
    row: { flexDirection: 'row' }, tile: { margin: 1, backgroundColor: c.surfaceStrong },
    selected: { borderWidth: 3, borderColor: c.primary },
    image: { width: '100%', height: '100%' },
    badge: { position: 'absolute', top: 4, right: 4, color: '#fff', backgroundColor: '#0009', padding: 5, borderRadius: 8 },
    move: { alignItems: 'center', borderTopWidth: 1, borderTopColor: c.surfaceStrong }, disabled: { opacity: 0.4 },
  });
}
