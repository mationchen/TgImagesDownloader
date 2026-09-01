/* eslint-disable no-script-url */
import {
  extractTelegraphUrls,
  isSafeImageUrl,
  isValidTelegraphUrl,
  normalizeTelegraphUrl,
  validateTelegraphUrl,
} from '../src/utils/url';

describe('utils/url', () => {
  describe('validateTelegraphUrl', () => {
    it.each([
      ['https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17', null],
      ['http://telegra.ph/foo/bar', null],
      ['https://telegra.ph/', 'INVALID_FORMAT'],
      ['https://example.com/foo', 'INVALID_HOST'],
      ['javascript:alert(1)', 'INVALID_PROTOCOL'],
      ['file:///etc/passwd', 'INVALID_PROTOCOL'],
      ['', 'EMPTY'],
      ['   ', 'EMPTY'],
    ])('validates %p -> %p', (input, expected) => {
      expect(validateTelegraphUrl(input)).toBe(expected);
    });
  });

  describe('isValidTelegraphUrl', () => {
    it('returns true for valid URL', () => {
      expect(
        isValidTelegraphUrl('https://telegra.ph/DJAWA-Photo-Vol0378'),
      ).toBe(true);
    });
    it('returns false for invalid URL', () => {
      expect(isValidTelegraphUrl('not a url')).toBe(false);
    });
  });

  describe('normalizeTelegraphUrl', () => {
    it('strips trailing punctuation from a bare URL', () => {
      expect(
        normalizeTelegraphUrl(
          'https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17).',
        ),
      ).toBe('https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17');
    });
    it('forces https and drops host casing', () => {
      expect(normalizeTelegraphUrl('HTTP://Telegra.ph/foo')).toBe(
        'https://telegra.ph/foo',
      );
    });
    it('returns null for invalid input', () => {
      expect(normalizeTelegraphUrl('not a url')).toBeNull();
    });
  });

  describe('extractTelegraphUrls', () => {
    it('extracts multiple URLs from prose and dedupes them', () => {
      const text = [
        'see https://telegra.ph/A.',
        'and https://telegra.ph/B, also https://telegra.ph/A again.',
        '',
      ].join('\n');
      expect(extractTelegraphUrls(text)).toEqual([
        'https://telegra.ph/A',
        'https://telegra.ph/B',
      ]);
    });
    it('returns empty array when no URL present', () => {
      expect(extractTelegraphUrls('plain text only')).toEqual([]);
    });
    it('ignores other domains', () => {
      expect(
        extractTelegraphUrls('https://example.com/x https://telegra.ph/y'),
      ).toEqual(['https://telegra.ph/y']);
    });
  });

  describe('isSafeImageUrl', () => {
    it.each([
      ['https://telegra.ph/file/x.jpg', true],
      ['http://cdn.example.com/img.png', true],
      ['file:///etc/passwd', false],
      ['javascript:alert(1)', false],
      ['data:image/png;base64,xxx', false],
      ['http://localhost/x.jpg', false],
      ['http://127.0.0.1/x.jpg', false],
      ['http://192.168.0.1/x.jpg', false],
      ['not a url', false],
    ])('checks %p -> %p', (input, expected) => {
      expect(isSafeImageUrl(input)).toBe(expected);
    });
  });
});