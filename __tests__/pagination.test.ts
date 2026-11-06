import {
  clampPageOffset,
  expectedImageCount,
  hasNextPage,
  lastPageOffset,
} from '../src/utils/pagination';

describe('utils/pagination', () => {
  describe('lastPageOffset', () => {
    it('aligns to the page boundary', () => {
      // 889 条、每页 100 → 最后一页从第 801 条开始。
      expect(lastPageOffset(889, 100)).toBe(800);
      expect(lastPageOffset(1000, 100)).toBe(900);
      expect(lastPageOffset(101, 100)).toBe(100);
      expect(lastPageOffset(100, 100)).toBe(0);
      expect(lastPageOffset(1, 100)).toBe(0);
    });

    it('returns 0 for empty or invalid input', () => {
      expect(lastPageOffset(0, 100)).toBe(0);
      expect(lastPageOffset(-5, 100)).toBe(0);
      expect(lastPageOffset(889, 0)).toBe(0);
    });
  });

  describe('clampPageOffset', () => {
    it('keeps an in-range offset untouched', () => {
      expect(clampPageOffset(0, 889, 100)).toBe(0);
      expect(clampPageOffset(100, 889, 100)).toBe(100);
      expect(clampPageOffset(800, 889, 100)).toBe(800);
    });

    it('falls back to the last full page when out of range', () => {
      // 旧实现用 PAGE_SIZE(20) 对齐，会算出 880 → 显示 881-889。
      expect(clampPageOffset(900, 889, 100)).toBe(800);
      expect(clampPageOffset(889, 889, 100)).toBe(800);
    });

    it('handles empty totals and junk input', () => {
      expect(clampPageOffset(200, 0, 100)).toBe(0);
      expect(clampPageOffset(-10, 889, 100)).toBe(0);
      expect(clampPageOffset(Number.NaN, 889, 100)).toBe(0);
    });
  });

  describe('hasNextPage', () => {
    it('is false on the last (possibly partial) page', () => {
      // 801-889：下一页起点 900 已超出总数 → 必须禁用。
      expect(hasNextPage(800, 889, 100)).toBe(false);
    });

    it('is true while the next page still starts within the total', () => {
      expect(hasNextPage(0, 889, 100)).toBe(true);
      expect(hasNextPage(700, 889, 100)).toBe(true);
      expect(hasNextPage(0, 101, 100)).toBe(true);
    });

    it('is false when the total is an exact multiple of the page size', () => {
      expect(hasNextPage(0, 100, 100)).toBe(false);
      expect(hasNextPage(100, 200, 100)).toBe(false);
    });

    it('is false for an empty list', () => {
      expect(hasNextPage(0, 0, 100)).toBe(false);
    });
  });

  describe('expectedImageCount', () => {
    it('uses perPage × (pages-1)+1 .. perPage × pages for multi-page galleries', () => {
      // 用户给的例子：每页 20 张、共 5 页 → 81..100
      expect(expectedImageCount(20, 5)).toEqual({ min: 81, max: 100 });
      // 每页 20 张、共 4 页 → 61..80
      expect(expectedImageCount(20, 4)).toEqual({ min: 61, max: 80 });
    });

    it('is exact for a single page', () => {
      expect(expectedImageCount(20, 1)).toEqual({ min: 20, max: 20 });
    });

    it('never returns a range below one image for junk input', () => {
      expect(expectedImageCount(0, 3)).toEqual({ min: 3, max: 3 });
      expect(expectedImageCount(20, 0)).toEqual({ min: 20, max: 20 });
    });
  });
});
