import React, {useCallback, useMemo, useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import type {TelegraphImage} from '../types/telegraph';
import {defaultResolverRegistry} from '../services/resolvers/registry';
import {t} from '../i18n';

type Props = {
  image: TelegraphImage;
  size: number;
  /** 点击图片区域：预览大图 */
  onPress: (image: TelegraphImage) => void;
  /** 点击对勾区域：切换选中/取消选中 */
  onToggle: (image: TelegraphImage) => void;
};

export const ThumbnailItem: React.FC<Props> = React.memo(
  ({image, size, onPress, onToggle}) => {
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);

    const blocked = useMemo(
      () => defaultResolverRegistry.resolve(image.url).kind === 'blocked',
      [image.url],
    );

    const handlePress = useCallback(() => {
      onPress(image);
    }, [image, onPress]);

    const handleToggle = useCallback(() => {
      onToggle(image);
    }, [image, onToggle]);

    return (
      <View
        style={[
          styles.container,
          {width: size, height: size},
          image.selected && styles.selected,
        ]}>
        <Pressable
          onPress={handlePress}
          style={({pressed}) => [styles.imagePress, pressed && styles.pressed]}>
          {blocked ? (
            <View style={styles.lockedBox}>
              <Text style={styles.lockedIcon}>🔒</Text>
              <Text style={styles.lockedText} numberOfLines={1}>
                {t('preview.blockedShort')}
              </Text>
            </View>
          ) : !failed ? (
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
          {!loaded && !failed && !blocked ? (
            <View style={styles.placeholder} pointerEvents="none" />
          ) : null}
          <View style={styles.indexBadge} pointerEvents="none">
            <Text style={styles.indexText}>
              {String(image.index).padStart(3, '0')}
            </Text>
          </View>
        </Pressable>

        <Pressable
          onPress={handleToggle}
          hitSlop={8}
          style={({pressed}) => [
            styles.checkWrap,
            pressed && styles.checkWrapPressed,
          ]}>
          {image.selected ? (
            <View style={styles.checkmark}>
              <Text style={styles.checkmarkText}>✓</Text>
            </View>
          ) : (
            <View style={styles.unselectedDot} />
          )}
        </Pressable>
      </View>
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
  imagePress: {
    flex: 1,
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
  lockedBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#efe7d3',
  },
  lockedIcon: {
    fontSize: 18,
  },
  lockedText: {
    marginTop: 2,
    fontSize: 9,
    color: '#8a6d1a',
    paddingHorizontal: 2,
    textAlign: 'center',
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
  checkWrap: {
    position: 'absolute',
    right: 2,
    top: 2,
    padding: 2,
  },
  checkWrapPressed: {
    opacity: 0.7,
  },
  checkmark: {
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
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});
