import {
  buildIndexFilename,
  sanitizeFilename,
} from '../src/utils/filename';

describe('utils/filename', () => {
  describe('sanitizeFilename', () => {
    it('strips reserved characters', () => {
      expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    });
    it('strips control characters', () => {
      expect(sanitizeFilename('a\u0000b\u0007c')).toBe('a_b_c');
    });
    it('collapses whitespace and strips edge dots', () => {
      expect(sanitizeFilename('  ..hello world..  ')).toBe('hello world');
    });
    it('falls back to "untitled" when nothing valid remains', () => {
      expect(sanitizeFilename('///')).toBe('untitled');
    });
    it('truncates to maxLen', () => {
      const long = 'a'.repeat(200);
      expect(sanitizeFilename(long, 50)).toHaveLength(50);
    });
  });

  describe('buildIndexFilename', () => {
    it('zero-pads to padTo (default 3)', () => {
      expect(buildIndexFilename(1, '.jpg')).toBe('001.jpg');
      expect(buildIndexFilename(99, '.jpg')).toBe('099.jpg');
      expect(buildIndexFilename(100, '.jpg')).toBe('100.jpg');
    });
    it('accepts ext without leading dot', () => {
      expect(buildIndexFilename(7, 'png')).toBe('007.png');
    });
    it('clamps invalid index to 1', () => {
      expect(buildIndexFilename(0, '.jpg')).toBe('001.jpg');
      expect(buildIndexFilename(-3, '.jpg')).toBe('001.jpg');
    });
    it('honors a custom pad width', () => {
      expect(buildIndexFilename(5, '.jpg', 5)).toBe('00005.jpg');
    });
  });
});