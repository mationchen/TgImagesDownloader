import {
  inferExtFromMime,
  inferExtFromUrl,
  inferMimeFromUrl,
  isAllowedImageMime,
} from '../src/utils/mime';

describe('utils/mime', () => {
  describe('inferExtFromUrl', () => {
    it.each([
      ['https://x.com/a/b/c.jpg', '.jpg'],
      ['https://x.com/foo.PNG', '.png'],
      ['https://x.com/foo.webp?q=1', '.webp'],
      ['https://x.com/foo', '.jpg'],
      ['https://x.com/foo.tar.gz', '.jpg'],
      ['', '.jpg'],
    ])('infers ext from %p -> %p', (input, expected) => {
      expect(inferExtFromUrl(input)).toBe(expected);
    });
  });

  describe('inferMimeFromUrl', () => {
    it('maps known extensions', () => {
      expect(inferMimeFromUrl('https://x.com/a.png')).toBe('image/png');
      expect(inferMimeFromUrl('https://x.com/a.webp')).toBe('image/webp');
    });
    it('falls back to image/jpeg', () => {
      expect(inferMimeFromUrl('https://x.com/a')).toBe('image/jpeg');
    });
  });

  describe('inferExtFromMime', () => {
    it.each([
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
      ['IMAGE/WEBP', '.webp'],
      ['application/json', '.jpg'],
    ])('maps %p -> %p', (input, expected) => {
      expect(inferExtFromMime(input)).toBe(expected);
    });
  });

  describe('isAllowedImageMime', () => {
    it('accepts image/*', () => {
      expect(isAllowedImageMime('image/jpeg')).toBe(true);
      expect(isAllowedImageMime('image/webp')).toBe(true);
    });
    it('rejects non-image', () => {
      expect(isAllowedImageMime('application/octet-stream')).toBe(false);
      expect(isAllowedImageMime('text/html')).toBe(false);
    });
    it('permits unknown (returns true so downstream can decide)', () => {
      expect(isAllowedImageMime(undefined)).toBe(true);
    });
  });
});