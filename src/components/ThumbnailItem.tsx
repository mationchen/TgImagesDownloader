import React, {useCallback, useState} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {TelegraphImage} from '../types/telegraph';

type Props = {
  image: TelegraphImage;
  size: number;
  onPress: (image: TelegraphImage) => void;
  onLongPress?: (image: TelegraphImage) => void;
};

export const ThumbnailItem: React.FC<Props> = React.memo(
  ({image, size, onPress, onLongPress}) => {
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);

    const handlePress = useCallback(() => {
      onPress(image);
    }, [image, onPress]);

    const handleLongPress = useCallback(() => {
      onLongPress?.(image);
    }, [image, onLongPress]);

    return (
      <Pressable
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={350}
        style={({pressed}) => [
          styles.container,
          {width: size, height: size},
          image.selected && styles.selected,
          pressed && styles.pressed,
        ]}>
        {!failed ? (
          <Image
            source={{uri: image.url}}
            style={styles.image}
            resizeMode="cover"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <View style={styles.fallback}>
            <Text style={styles.fallbackText}>×</Text>
          </View>
        )}
        {!loaded && !failed ? (
          <View style={styles.placeholder} pointerEvents="none" />
        ) : null}
        <View style={styles.indexBadge} pointerEvents="none">
          <Text style={styles.indexText}>
            {String(image.index).padStart(3, '0')}
          </Text>
        </View>
        {image.selected ? (
          <View style={styles.checkmark} pointerEvents="none">
            <Text style={styles.checkmarkText}>✓</Text>
          </View>
        ) : (
          <View style={styles.unselectedDot} pointerEvents="none" />
        )}
      </Pressable>
    );
  },
);

ThumbnailItem.displayName = 'ThumbnailItem';

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#f0f0f0',
    overflow: 'hidden',
    margin: 4,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selected: {
    borderColor: '#1976d2',
  },
  pressed: {
    opacity: 0.7,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#ececec',
  },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fde0e0',
  },
  fallbackText: {
    fontSize: 24,
    color: '#c33',
    fontWeight: '700',
  },
  indexBadge: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  indexText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  checkmark: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1976d2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmarkText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  unselectedDot: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});
