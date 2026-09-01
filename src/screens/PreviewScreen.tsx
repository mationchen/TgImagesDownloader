import React, {useCallback, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {ImageGrid} from '../components/ImageGrid';
import {ViewerModal} from '../components/ViewerModal';
import type {RootStackScreenProps} from '../navigation/types';
import {t} from '../i18n';
import type {TelegraphImage} from '../types/telegraph';

type Props = RootStackScreenProps<'Preview'>;

type SelectionMode = 'all' | 'none' | 'mixed';

export const PreviewScreen: React.FC<Props> = ({route, navigation}) => {
  const {article} = route.params;
  const [images, setImages] = useState<TelegraphImage[]>(article.images);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  React.useLayoutEffect(() => {
    navigation.setOptions({title: article.title.slice(0, 32) || 'Preview'});
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

  const toggleOne = useCallback((target: TelegraphImage) => {
    setImages(prev =>
      prev.map(img =>
        img.id === target.id ? {...img, selected: !img.selected} : img,
      ),
    );
  }, []);

  const handleItemPress = useCallback((_img: TelegraphImage, idx: number) => {
    setViewerIndex(idx);
  }, []);

  const handleItemLongPress = useCallback(
    (img: TelegraphImage) => {
      toggleOne(img);
    },
    [toggleOne],
  );

  const selectAll = useCallback(() => {
    setImages(prev => prev.map(img => ({...img, selected: true})));
  }, []);

  const deselectAll = useCallback(() => {
    setImages(prev => prev.map(img => ({...img, selected: false})));
  }, []);

  const invertSelection = useCallback(() => {
    setImages(prev => prev.map(img => ({...img, selected: !img.selected})));
  }, []);

  const closeViewer = useCallback(() => setViewerIndex(null), []);

  const startDownload = useCallback(() => {
    if (selectedImages.length === 0) return;
    navigation.navigate('Download', {
      article,
      images: selectedImages,
    });
  }, [article, selectedImages, navigation]);

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>{t('preview.title')}</Text>
        <Text style={styles.headerTitle} numberOfLines={2}>
          {article.title}
        </Text>
        <Text style={styles.headerCount}>
          {t('preview.imageCount', {count: images.length})}
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
        onItemPress={handleItemPress}
        onItemLongPress={handleItemLongPress}
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
            style={({pressed}) => [
              styles.startBtn,
              selectedCount === 0 && styles.startBtnDisabled,
              pressed && selectedCount > 0 && styles.startBtnPressed,
            ]}>
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

const ToolbarButton: React.FC<BtnProps> = ({label, onPress, active, testID}) => {
  return (
    <Text
      testID={testID}
      onPress={onPress}
      style={[styles.toolbarBtn, active && styles.toolbarBtnActive]}>
      {label}
    </Text>
  );
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#f6f8fa',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  headerLabel: {
    fontSize: 12,
    color: '#888',
  },
  headerTitle: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
  },
  headerCount: {
    marginTop: 6,
    fontSize: 13,
    color: '#1976d2',
    fontWeight: '600',
  },
  toolbar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  toolbarBtn: {
    marginRight: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    color: '#1976d2',
    fontSize: 13,
    fontWeight: '500',
    overflow: 'hidden',
  },
  toolbarBtnActive: {
    backgroundColor: '#e3f0fc',
    color: '#0d5fb8',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e5e5',
  },
  footerLeft: {
    flex: 1,
    paddingRight: 12,
  },
  footerHint: {
    fontSize: 13,
    color: '#666',
    fontVariant: ['tabular-nums'],
  },
  footerBtnWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  startBtn: {
    backgroundColor: '#1976d2',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startBtnText: {
    color: '#fff',
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
    paddingBottom: 6,
    paddingTop: 2,
    fontSize: 11,
    color: '#888',
    backgroundColor: '#fff',
  },
});
