import {
  clamp,
  clampTranslate,
  containFit,
  maxTranslateFor,
} from '../src/utils/zoom';

describe('utils/zoom', () => {
  describe('clamp', () => {
    it('clamps within range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });
  });

  describe('containFit', () => {
    it('fits a wide image by width', () => {
      // 200x100 into 100x100 -> 100x50
      expect(containFit(200, 100, 100, 100)).toEqual({
        width: 100,
        height: 50,
      });
    });

    it('fits a tall image by height', () => {
      // 100x200 into 100x100 -> 50x100
      expect(containFit(100, 200, 100, 100)).toEqual({
        width: 50,
        height: 100,
      });
    });

    it('falls back to the box when inputs are invalid', () => {
      expect(containFit(0, 0, 100, 80)).toEqual({ width: 100, height: 80 });
      expect(containFit(200, 100, 0, 0)).toEqual({ width: 0, height: 0 });
    });
  });

  describe('maxTranslateFor', () => {
    it('is zero when the scaled image is smaller than the box', () => {
      expect(maxTranslateFor(100, 200, 1)).toBe(0);
      expect(maxTranslateFor(100, 200, 1.5)).toBe(0);
    });

    it('returns half the overflow when larger', () => {
      // 100 * 3 = 300, box 200 -> overflow 100 -> half 50
      expect(maxTranslateFor(100, 200, 3)).toBe(50);
    });
  });

  describe('clampTranslate', () => {
    it('keeps translate within the computed bounds', () => {
      // displayed 100x100 scaled 3x inside 200x200 -> max 50 each axis
      expect(clampTranslate(999, -999, 100, 100, 200, 200, 3)).toEqual({
        x: 50,
        y: -50,
      });
    });

    it('pins to zero when the image does not overflow', () => {
      expect(clampTranslate(30, 30, 100, 100, 200, 200, 1)).toEqual({
        x: 0,
        y: 0,
      });
    });
  });
});
