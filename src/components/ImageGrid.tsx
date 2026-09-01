import React, {useCallback, useMemo} from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type {TelegraphImage} from '../types/telegraph';
import {ThumbnailItem} from './ThumbnailItem';

type Props = {
  images: TelegraphImage[];
  onItemPress: (image: TelegraphImage, index: number) => void;
  onItemLongPress?: (image: TelegraphImage, index: number) => void;
  /** Number of grid columns. Default 3. */
  columns?: number;
};

const GUTTER = 8;
const SIDE_PADDING = 8;

export const ImageGrid: React.FC<Props> = ({
  images,
  onItemPress,
  onItemLongPress,
  columns = 3,
}) => {
  const {width} = useWindowDimensions();
  const cellSize = useMemo(() => {
    const totalGutters = GUTTER * (columns - 1) + SIDE_PADDING * 2;
    return Math.floor((width - totalGutters) / columns);
  }, [width, columns]);

  const renderItem = useCallback(
    ({item}: ListRenderItemInfo<TelegraphImage>) => {
      return (
        <ThumbnailItem
          image={item}
          size={cellSize}
          onPress={img => onItemPress(img, img.index - 1)}
          onLongPress={
            onItemLongPress
              ? img => onItemLongPress(img, img.index - 1)
              : undefined
          }
        />
      );
    },
    [cellSize, onItemPress, onItemLongPress],
  );

  const keyExtractor = useCallback((item: TelegraphImage) => item.id, []);

  const ItemSeparator = useCallback(
    () => <View style={styles.separator} />,
    [],
  );

  return (
    <FlatList
      data={images}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      numColumns={columns}
      contentContainerStyle={styles.content}
      ItemSeparatorComponent={ItemSeparator}
      removeClippedSubviews
      windowSize={5}
      initialNumToRender={columns * 4}
      maxToRenderPerBatch={columns * 4}
    />
  );
};

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: SIDE_PADDING - 4,
    paddingTop: 4,
    paddingBottom: 24,
  },
  separator: {
    height: 0,
  },
});
