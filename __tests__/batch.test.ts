import {dedupeUrls} from '../src/utils/batchScheduler';

describe('utils/batchScheduler', () => {
  describe('dedupeUrls', () => {
    it('strips blank lines and trims whitespace', () => {
      expect(
        dedupeUrls(['  https://x.test/a  ', '', '   ', 'https://x.test/b']),
      ).toEqual(['https://x.test/a', 'https://x.test/b']);
    });

    it('removes duplicates while keeping the first occurrence order', () => {
      expect(
        dedupeUrls([
          'https://x.test/a',
          'https://x.test/b',
          'https://x.test/a',
          'https://x.test/c',
          'https://x.test/b',
        ]),
      ).toEqual(['https://x.test/a', 'https://x.test/b', 'https://x.test/c']);
    });

    it('handles CRLF / LF / mixed line endings', () => {
      // The picker gives raw file content; the consumer splits on any newline.
      // This function only trims + dedupes; splitting happens upstream.
      const raw = 'https://x.test/a\r\nhttps://x.test/b\n\nhttps://x.test/a';
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      expect(dedupeUrls(lines)).toEqual([
        'https://x.test/a',
        'https://x.test/b',
      ]);
    });

    it('returns an empty array for empty input', () => {
      expect(dedupeUrls([])).toEqual([]);
      expect(dedupeUrls([''])).toEqual([]);
    });

    it('keeps protocol + case-distinct URLs distinct', () => {
      // The deduper is case-sensitive — that's the safe default; we don't
      // want to silently rewrite the user's list.
      expect(
        dedupeUrls(['https://x.test/A', 'https://x.test/a']),
      ).toEqual(['https://x.test/A', 'https://x.test/a']);
    });
  });
});