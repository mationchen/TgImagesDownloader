import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { clamp, clampTranslate, containFit } from '../utils/zoom';

type ImageLoadEvent = NativeSyntheticEvent<{
  source: { width: number; height: number; uri: string };
}>;

type Props = {
  uri: string;
  /**
   * Fired when the image enters/leaves a zoomed state. The parent paging
   * ScrollView should set `scrollEnabled={!zoomed}` so a zoomed image can be
   * dragged without swiping to the next page.
   */
  onZoomChange?: (zoomed: boolean) => void;
  onLoadEnd?: () => void;
  onError?: () => void;
  /** Max pinch scale. Default 4. */
  maxScale?: number;
  /** Scale applied by a double tap. Default 2.5. */
  doubleTapScale?: number;
  style?: StyleProp<ViewStyle>;
};

const DOUBLE_TAP_MS = 300;
const MOVE_CLAIM_THRESHOLD = 6; // px of movement before a zoomed drag is claimed
const ZOOM_EPSILON = 1.01;

type Size = { width: number; height: number };

function touchDistance(
  a: { pageX: number; pageY: number },
  b: { pageX: number; pageY: number },
): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/**
 * Dependency-free zoomable image: pinch-to-zoom, drag-to-pan (only while
 * zoomed), and double-tap to toggle zoom. Uses RN's built-in PanResponder +
 * Animated, so it works on Android and iOS with no native config.
 *
 * Gesture routing is deliberate: single-finger taps are NOT captured by the
 * pan responder, so a parent paging ScrollView still receives horizontal
 * swipes while at 1x. Two-finger gestures (and drags once zoomed) are
 * captured so they don't leak to the ScrollView.
 */
export const ZoomableImage: React.FC<Props> = ({
  uri,
  onZoomChange,
  onLoadEnd,
  onError,
  maxScale = 4,
  doubleTapScale = 2.5,
  style,
}) => {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // Numeric mirrors so gesture math never depends on reading Animated state.
  const scaleV = useRef(1);
  const txV = useRef(0);
  const tyV = useRef(0);

  const boxRef = useRef<Size>({ width: 0, height: 0 });
  const fittedRef = useRef<Size>({ width: 0, height: 0 });

  const startScale = useRef(1);
  const startTx = useRef(0);
  const startTy = useRef(0);
  const startDistance = useRef(0);
  const startMid = useRef({ x: 0, y: 0 });
  const pinching = useRef(false);
  const lastTapAt = useRef(0);
  const zoomedRef = useRef(false);

  // Keep the latest callback without re-creating the PanResponder / retriggering
  // the uri-reset effect.
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const emitZoom = useCallback((next: boolean) => {
    if (zoomedRef.current === next) return;
    zoomedRef.current = next;
    onZoomChangeRef.current?.(next);
  }, []);

  const applyTransform = useCallback(
    (s: number, x: number, y: number) => {
      scaleV.current = s;
      txV.current = x;
      tyV.current = y;
      scale.setValue(s);
      translateX.setValue(x);
      translateY.setValue(y);
    },
    [scale, translateX, translateY],
  );

  const clampCurrent = useCallback((s: number, x: number, y: number) => {
    const box = boxRef.current;
    const fit = fittedRef.current;
    return clampTranslate(
      x,
      y,
      fit.width || box.width,
      fit.height || box.height,
      box.width,
      box.height,
      s,
    );
  }, []);

  const animateTo = useCallback(
    (s: number, x: number, y: number) => {
      scaleV.current = s;
      txV.current = x;
      tyV.current = y;
      Animated.parallel([
        Animated.timing(scale, {
          toValue: s,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: x,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: y,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [scale, translateX, translateY],
  );

  const settle = useCallback(() => {
    pinching.current = false;
    const s = scaleV.current;
    if (s <= ZOOM_EPSILON) {
      animateTo(1, 0, 0);
      emitZoom(false);
      return;
    }
    const c = clampCurrent(s, txV.current, tyV.current);
    animateTo(s, c.x, c.y);
    emitZoom(true);
  }, [animateTo, clampCurrent, emitZoom]);

  // Reset whenever the displayed image changes.
  useEffect(() => {
    scale.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();
    applyTransform(1, 0, 0);
    zoomedRef.current = false;
    onZoomChangeRef.current?.(false);
  }, [uri, applyTransform, scale, translateX, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Never claim a plain single-finger touch on start: taps go to the
        // inner Pressable, swipes go to the parent paging ScrollView.
        onStartShouldSetPanResponder: () => false,
        // But DO capture two fingers immediately so a pinch never turns into a
        // page swipe.
        onStartShouldSetPanResponderCapture: e =>
          e.nativeEvent.touches.length >= 2,
        onMoveShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: (e, g) => {
          if (e.nativeEvent.touches.length >= 2) return true;
          return (
            scaleV.current > 1 &&
            (Math.abs(g.dx) > MOVE_CLAIM_THRESHOLD ||
              Math.abs(g.dy) > MOVE_CLAIM_THRESHOLD)
          );
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: e => {
          startScale.current = scaleV.current;
          startTx.current = txV.current;
          startTy.current = tyV.current;
          const touches = e.nativeEvent.touches;
          if (touches.length >= 2) {
            pinching.current = true;
            startDistance.current = touchDistance(touches[0], touches[1]);
            startMid.current = {
              x: (touches[0].pageX + touches[1].pageX) / 2,
              y: (touches[0].pageY + touches[1].pageY) / 2,
            };
          } else {
            pinching.current = false;
            startDistance.current = 0;
          }
        },
        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;
          if (touches.length >= 2) {
            const dist = touchDistance(touches[0], touches[1]);
            const mid = {
              x: (touches[0].pageX + touches[1].pageX) / 2,
              y: (touches[0].pageY + touches[1].pageY) / 2,
            };
            if (!pinching.current || startDistance.current <= 0) {
              // A second finger just landed mid-gesture; start pinch tracking.
              pinching.current = true;
              startScale.current = scaleV.current;
              startTx.current = txV.current;
              startTy.current = tyV.current;
              startDistance.current = dist;
              startMid.current = mid;
              return;
            }
            const nextScale = clamp(
              startScale.current * (dist / startDistance.current),
              1,
              maxScale,
            );
            const nextX = startTx.current + (mid.x - startMid.current.x);
            const nextY = startTy.current + (mid.y - startMid.current.y);
            const c = clampCurrent(nextScale, nextX, nextY);
            applyTransform(nextScale, c.x, c.y);
            emitZoom(nextScale > ZOOM_EPSILON);
            return;
          }
          // Single-finger drag: only reachable when already zoomed, because
          // the responder was claimed via onMoveShouldSetPanResponderCapture.
          const c = clampCurrent(
            scaleV.current,
            startTx.current + g.dx,
            startTy.current + g.dy,
          );
          applyTransform(scaleV.current, c.x, c.y);
          emitZoom(true);
        },
        onPanResponderRelease: settle,
        onPanResponderTerminate: settle,
      }),
    [applyTransform, clampCurrent, emitZoom, maxScale, settle],
  );

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      const now = Date.now();
      if (now - lastTapAt.current > DOUBLE_TAP_MS) {
        lastTapAt.current = now;
        return;
      }
      lastTapAt.current = 0;
      if (scaleV.current > ZOOM_EPSILON) {
        animateTo(1, 0, 0);
        emitZoom(false);
        return;
      }
      const box = boxRef.current;
      const px = e.nativeEvent.locationX - box.width / 2;
      const py = e.nativeEvent.locationY - box.height / 2;
      const nextScale = doubleTapScale;
      const c = clampCurrent(
        nextScale,
        -px * (nextScale - 1),
        -py * (nextScale - 1),
      );
      animateTo(nextScale, c.x, c.y);
      emitZoom(true);
    },
    [animateTo, clampCurrent, doubleTapScale, emitZoom],
  );

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    boxRef.current = { width, height };
  }, []);

  const handleLoad = useCallback((e: ImageLoadEvent) => {
    const src = e.nativeEvent.source;
    const box = boxRef.current;
    fittedRef.current = containFit(
      src?.width ?? 0,
      src?.height ?? 0,
      box.width,
      box.height,
    );
  }, []);

  return (
    <Animated.View
      style={[
        styles.container,
        style,
        { transform: [{ translateX }, { translateY }, { scale }] },
      ]}
      onLayout={handleLayout}
      {...panResponder.panHandlers}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={handlePress}>
        <Image
          source={{ uri }}
          style={styles.image}
          resizeMode="contain"
          onLoad={handleLoad}
          onLoadEnd={onLoadEnd}
          onError={onError}
        />
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
});

export default ZoomableImage;
