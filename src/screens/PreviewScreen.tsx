import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ImageGrid } from '../components/ImageGrid';
import { ViewerModal } from '../components/ViewerModal';
import type { RootStackScreenProps } from '../navigation/types';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';
import type { TelegraphImage } from '../types/telegraph';

type Props = RootStackScreenProps<'Preview'>;

type SelectionMode = 'all' | 'none' | 'mixed';

export const PreviewScreen: React.FC<Props> = ({ route, navigation }) => {
  // Subscribe so all strings re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { article } = route.params;
  const [images, setImages] = useState<TelegraphImage[]>(article.images);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: article.title.slice(0, 32) || 'Preview' });
  }, [navigation, article.title]);

  const selectionMode = useMemo<SelectionMode>(() => {
    const selectedCount = images.filter(i => i.selected).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === images.length) return 'all';
    return 'mixed';
  }, [images]);

  const selectedCount = useMemo(
    () => images.filter(i => i.selected).length,
    [images],
  );

  const selectedImages = useMemo(
    () => images.filter(i => i.selected),
    [images],
  );
  const selectedIdsSet = useMemo(
    () => new Set(selectedImages.map(i => i.id)),
    [selectedImages],
  );

  const toggleOne = useCallback((target: TelegraphImage) => {
    setImages(prev =>
      prev.map(img =>
        img.id === target.id ? { ...img, selected: !img.selected } : img,
      ),
    );
  }, []);

  const handlePreview = useCallback((_img: TelegraphImage, idx: number) => {
    setViewerIndex(idx);
  }, []);

  const handleToggle = useCallback(
    (img: TelegraphImage) => {
      toggleOne(img);
    },
    [toggleOne],
  );

  const selectAll = useCallback(() => {
    setImages(prev => prev.map(img => ({ ...img, selected: true })));
  }, []);

  const deselectAll = useCallback(() => {
    setImages(prev => prev.map(img => ({ ...img, selected: false })));
  }, []);

  const invertSelection = useCallback(() => {
    setImages(prev => prev.map(img => ({ ...img, selected: !img.selected })));
  }, []);

  const closeViewer = useCallback(() => setViewerIndex(null), []);

  const startDownload = useCallback(() => {
    if (selectedImages.length === 0) return;
    // Download in reverse source order so the saved MediaStore entries show
    // up in the system gallery in *forward* source order (the last image in
    // the article appears first because it was inserted last).
    navigation.navigate('Download', {
      article,
      images: [...selectedImages].reverse(),
    });
  }, [article, selectedImages, navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>{t('preview.title')}</Text>
        <Text style={styles.headerTitle} numberOfLines={2}>
          {article.title}
        </Text>
        <Text style={styles.headerCount}>
          {t('preview.imageCount', { count: images.length })}
        </Text>
      </View>

      <View style={styles.toolbar}>
        <ToolbarButton
          label={t('preview.selectAll')}
          onPress={selectAll}
          active={selectionMode === 'all'}
          testID="btn-select-all"
        />
        <ToolbarButton
          label={t('preview.deselectAll')}
          onPress={deselectAll}
          active={selectionMode === 'none'}
          testID="btn-deselect-all"
        />
        <ToolbarButton
          label={t('preview.invertSelection')}
          onPress={invertSelection}
          active={selectionMode === 'mixed'}
          testID="btn-invert"
        />
      </View>

      <ImageGrid
        images={images}
        onItemPress={handlePreview}
        onItemToggle={handleToggle}
      />

      <View style={styles.footer}>
        <View style={styles.footerLeft}>
          <Text style={styles.footerHint}>
            {selectedCount} / {images.length}
          </Text>
        </View>
        <View style={styles.footerBtnWrap}>
          <Pressable
            onPress={startDownload}
            disabled={selectedCount === 0}
            style={({ pressed }) => [
              styles.startBtn,
              selectedCount === 0 && styles.startBtnDisabled,
              pressed && selectedCount > 0 && styles.startBtnPressed,
            ]}
          >
            <Text style={styles.startBtnText}>
              {t('preview.startDownload')}
            </Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.pathHint}>{t('download.pathHint')}</Text>

      <ViewerModal
        visible={viewerIndex !== null}
        images={images}
        initialIndex={viewerIndex ?? 0}
        onClose={closeViewer}
        selectedIds={selectedIdsSet}
        onToggleSelect={toggleOne}
      />
    </SafeAreaView>
  );
};

type BtnProps = {
  label: string;
  onPress: () => void;
  active: boolean;
  testID?: string;
};

const ToolbarButton: React.FC<BtnProps> = ({
  label,
  onPress,
  active,
  testID,
}) => {
  const styles = useThemedStyles(createStyles);
  return (
    <Text
      testID={testID}
      onPress={onPress}
      style={[styles.toolbarBtn, active && styles.toolbarBtnActive]}
    >
      {label}
    </Text>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 10,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerLabel: {
      fontSize: 12,
      color: c.textHint,
    },
    headerTitle: {
      marginTop: 4,
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    headerCount: {
      marginTop: 6,
      fontSize: 13,
      color: c.primary,
      fontWeight: '600',
    },
    toolbar: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: c.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    toolbarBtn: {
      marginRight: 12,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      color: c.primary,
      fontSize: 13,
      fontWeight: '500',
      overflow: 'hidden',
    },
    toolbarBtnActive: {
      backgroundColor: c.primarySoft,
      color: c.primarySoftText,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: c.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    footerLeft: {
      flex: 1,
      paddingRight: 12,
    },
    footerHint: {
      fontSize: 13,
      color: c.textSecondary,
      fontVariant: ['tabular-nums'],
    },
    footerBtnWrap: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    startBtn: {
      backgroundColor: c.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 8,
      minWidth: 120,
      alignItems: 'center',
      justifyContent: 'center',
    },
    startBtnText: {
      color: c.textOnPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    startBtnDisabled: {
      opacity: 0.45,
    },
    startBtnPressed: {
      opacity: 0.8,
    },
    pathHint: {
      paddingHorizontal: 16,
      paddingBottom: 14,
      paddingTop: 6,
      fontSize: 11,
      color: c.textHint,
      backgroundColor: c.background,
    },
  });
}
