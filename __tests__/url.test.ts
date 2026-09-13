/* eslint-disable no-script-url */
import {
  extractTelegraphUrls,
  extractWebUrls,
  isSafeFetchUrl,
  isSafeImageUrl,
  isValidTelegraphUrl,
  normalizeTelegraphUrl,
  normalizeWebUrl,
  validateTelegraphUrl,
  validateWebUrl,
} from '../src/utils/url';

describe('utils/url', () => {
  describe('validateTelegraphUrl', () => {
    it.each([
      [
        'https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17',
        null,
      ],
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
      ).toBe(
        'https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17',
      );
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

  describe('validateWebUrl / normalizeWebUrl (generic web pages)', () => {
    it('accepts public http(s) URLs', () => {
      expect(validateWebUrl('https://everia.club/2026/08/31/foo/')).toBeNull();
      expect(validateWebUrl('http://example.com/x')).toBeNull();
    });
    it('rejects empty / bad protocol / non-URL', () => {
      expect(validateWebUrl('')).toBe('EMPTY');
      expect(validateWebUrl('   ')).toBe('EMPTY');
      expect(validateWebUrl('javascript:alert(1)')).toBe('INVALID_PROTOCOL');
      expect(validateWebUrl('file:///etc')).toBe('INVALID_PROTOCOL');
      expect(validateWebUrl('not a url')).toBe('INVALID_FORMAT');
    });
    it('rejects SSRF targets (private / loopback / internal)', () => {
      expect(validateWebUrl('http://localhost/x')).toBe('SSRF_BLOCKED');
      expect(validateWebUrl('http://127.0.0.1/x')).toBe('SSRF_BLOCKED');
      expect(validateWebUrl('http://192.168.0.1/x')).toBe('SSRF_BLOCKED');
      expect(validateWebUrl('http://10.0.0.5/x')).toBe('SSRF_BLOCKED');
      expect(validateWebUrl('http://172.16.0.1/x')).toBe('SSRF_BLOCKED');
      expect(validateWebUrl('http://0.0.0.0/x')).toBe('SSRF_BLOCKED');
    });
    it('normalizeWebUrl trims trailing punctuation and drops hash', () => {
      expect(normalizeWebUrl('https://example.com/a).')).toBe(
        'https://example.com/a',
      );
      expect(normalizeWebUrl('https://example.com/a#section')).toBe(
        'https://example.com/a',
      );
      expect(normalizeWebUrl('not a url')).toBeNull();
    });
    it('extractWebUrls pulls any http(s) URL from prose', () => {
      expect(
        extractWebUrls('see https://everia.club/a and https://telegra.ph/b'),
      ).toEqual(['https://everia.club/a', 'https://telegra.ph/b']);
    });
    it('extractWebUrls accepts a schemeless link by assuming https', () => {
      expect(extractWebUrls('telegra.ph/abc-09-03')).toEqual([
        'https://telegra.ph/abc-09-03',
      ]);
      expect(extractWebUrls('  www.telegra.ph/abc  ')).toEqual([
        'https://www.telegra.ph/abc',
      ]);
    });
    it('extractWebUrls ignores non-links even without scheme', () => {
      expect(extractWebUrls('just some words')).toEqual([]);
      expect(extractWebUrls('not a url at all')).toEqual([]);
      expect(extractWebUrls('')).toEqual([]);
    });
    it('extractWebUrls does not mistake dotted numbers for a link', () => {
      expect(extractWebUrls('3.14')).toEqual([]);
      expect(extractWebUrls('v1.2')).toEqual([]);
      expect(extractWebUrls('1.2.3')).toEqual([]);
    });
    it('extractWebUrls strips invisible chars copied from chat apps', () => {
      expect(extractWebUrls('https://telegra.ph/abc\u200bdef')).toEqual([
        'https://telegra.ph/abcdef',
      ]);
    });
  });

  describe('isSafeFetchUrl (SSRF guard for page fetching)', () => {
    it.each([
      ['https://everia.club/a', true],
      ['https://karubox.top/x.webp', true],
      ['http://localhost/', false],
      ['http://127.0.0.1/', false],
      ['http://192.168.1.10/', false],
      ['http://10.1.2.3/', false],
      ['http://169.254.169.254/', false], // cloud metadata
      ['ftp://example.com/', false],
      ['file:///etc/passwd', false],
      ['not a url', false],
    ])('checks %p -> %p', (input, expected) => {
      expect(isSafeFetchUrl(input)).toBe(expected);
    });
  });
});
