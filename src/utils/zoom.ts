/**
 * Pure geometry helpers for the pinch/pan image viewer. Kept dependency-free
 * and side-effect-free so they can be unit-tested in isolation.
 */

export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Fit a natural (w,h) into a box (w,h) using "contain" semantics.
 * Falls back to the box size when any input is invalid.
 */
export function containFit(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
): { width: number; height: number } {
  if (
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    boxWidth <= 0 ||
    boxHeight <= 0
  ) {
    return { width: boxWidth, height: boxHeight };
  }
  const ratio = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  return { width: naturalWidth * ratio, height: naturalHeight * ratio };
}

/**
 * Max allowed translate (in screen px) along one axis for a scaled image
 * displayed inside a box. Zero when the scaled image is smaller than the box
 * (i.e. it should stay centered).
 */
export function maxTranslateFor(
  displayedSize: number,
  boxSize: number,
  scale: number,
): number {
  return Math.max(0, (displayedSize * scale - boxSize) / 2);
}

/**
 * Clamp a translate pair so the scaled image never leaves a blank gap inside
 * the box on either axis.
 */
export function clampTranslate(
  tx: number,
  ty: number,
  displayedWidth: number,
  displayedHeight: number,
  boxWidth: number,
  boxHeight: number,
  scale: number,
): { x: number; y: number } {
  const maxX = maxTranslateFor(displayedWidth, boxWidth, scale);
  const maxY = maxTranslateFor(displayedHeight, boxHeight, scale);
  return { x: clamp(tx, -maxX, maxX), y: clamp(ty, -maxY, maxY) };
}
