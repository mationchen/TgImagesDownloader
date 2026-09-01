import React, {useCallback, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {t} from '../i18n';
import {probeImageUrl} from '../services/imageDownloader';
import type {TelegraphImage} from '../types/telegraph';

type Props = {
  visible: boolean;
  images: TelegraphImage[];
  initialIndex: number;
  onClose: () => void;
};

export const ViewerModal: React.FC<Props> = ({
  visible,
  images,
  initialIndex,
  onClose,
}) => {
  const {width} = useWindowDimensions();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const scrollRef = useRef<ScrollViewInstance>(null);

  // Reset to initialIndex whenever modal becomes visible
  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          x: initialIndex * width,
          animated: false,
        });
      });
    }
  }, [visible, initialIndex, width]);

  const handleScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const idx = Math.round(x / width);
      if (idx !== currentIndex && idx >= 0 && idx < images.length) {
        setCurrentIndex(idx);
      }
    },
    [currentIndex, images.length, width],
  );

  const safeIndex = Math.max(0, Math.min(currentIndex, images.length - 1));
  const current = images[safeIndex];

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={({pressed}) => [styles.closeBtn, pressed && styles.pressed]}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>
          <Text style={styles.counter}>
            {t('preview.viewerIndex', {
              current: safeIndex + 1,
              total: images.length,
            })}
          </Text>
          <View style={styles.placeholder} />
        </View>

        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          scrollEventThrottle={16}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}>
          {images.map(img => (
            <ImagePage key={img.id} image={img} width={width} />
          ))}
        </ScrollView>

        <View style={styles.footer} pointerEvents="none">
          <Text style={styles.filename} numberOfLines={1}>
            {current?.filename ?? ''}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const ImagePage: React.FC<{image: TelegraphImage; width: number}> = ({
  image,
  width,
}) => {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [probing, setProbing] = useState(false);
  const [probeLabel, setProbeLabel] = useState<string | null>(null);

  const handleRetry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    setProbeLabel(null);
    setRetryKey(k => k + 1);
  }, []);

  const handleProbe = useCallback(async () => {
    if (probing) return;
    setProbing(true);
    setProbeLabel(null);
    try {
      const result = await probeImageUrl(image.url);
      if (result.kind === 'ok') {
        setProbeLabel(t('preview.imageProbeOk'));
      } else if (result.kind === 'hotlink') {
        setProbeLabel(t('preview.imageProbeHotlink'));
      } else if (result.kind === 'http') {
        setProbeLabel(t('preview.imageProbeHttp', {status: result.status}));
      } else {
        setProbeLabel(t('preview.imageProbeNetwork'));
      }
    } catch {
      setProbeLabel(t('preview.imageProbeNetwork'));
    } finally {
      setProbing(false);
    }
  }, [image.url, probing]);

  return (
    <View style={[styles.page, {width}]}>
      {!failed ? (
        <Image
          key={retryKey}
          source={{uri: image.url}}
          style={styles.fullImage}
          resizeMode="contain"
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        />
      ) : (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{t('preview.imageLoadFailed')}</Text>
          <View style={styles.errorActions}>
            <Pressable
              onPress={handleRetry}
              style={({pressed}) => [
                styles.retryBtn,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </Pressable>
            <Pressable
              onPress={handleProbe}
              disabled={probing}
              style={({pressed}) => [
                styles.retryBtn,
                styles.probeBtn,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.retryText}>
                {probing ? t('common.loading') : t('preview.imageProbe')}
              </Text>
            </Pressable>
          </View>
          {probeLabel ? (
            <Text style={styles.probeResult}>{probeLabel}</Text>
          ) : null}
        </View>
      )}
      {loading && !failed ? (
        <View style={styles.loadingBox} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  closeBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
  },
  counter: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  placeholder: {width: 40},
  scroll: {flex: 1},
  scrollContent: {alignItems: 'center'},
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  loadingBox: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  errorActions: {
    flexDirection: 'row',
    marginTop: 4,
  },
  errorText: {
    color: '#fff',
    fontSize: 15,
    marginBottom: 12,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fff',
    marginHorizontal: 4,
  },
  probeBtn: {
    borderColor: '#ffc107',
  },
  probeResult: {
    color: '#ffd54f',
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  filename: {
    color: '#ddd',
    fontSize: 13,
  },
  pressed: {
    opacity: 0.7,
  },
});
