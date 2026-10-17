import { decodeHtmlEntities } from '../src/utils/htmlEntities';

describe('decodeHtmlEntities', () => {
  it('decodes the numeric entity that shows up in scraped titles', () => {
    // Real case: an everia.club gallery title saved verbatim.
    expect(decodeHtmlEntities('Cosplay Bangni &#8211; Eviera.club')).toBe(
      'Cosplay Bangni \u2013 Eviera.club',
    );
  });

  it('decodes hexadecimal references', () => {
    expect(decodeHtmlEntities('a &#x2013; b &#X2019; c')).toBe(
      'a \u2013 b \u2019 c',
    );
  });

  it('decodes the common named references', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry &lt;3 &quot;x&quot;')).toBe(
      'Tom & Jerry <3 "x"',
    );
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a\u00a0b');
  });

  it('handles astral code points', () => {
    expect(decodeHtmlEntities('&#128512;')).toBe('\u{1f600}');
  });

  it('leaves unknown or malformed references alone', () => {
    expect(decodeHtmlEntities('&notarealone; &#; &#0; 100% &')).toBe(
      '&notarealone; &#; &#0; 100% &',
    );
  });

  it('is a no-op for plain text (and for empty input)', () => {
    expect(decodeHtmlEntities('普通标题 123')).toBe('普通标题 123');
    expect(decodeHtmlEntities('')).toBe('');
  });
});
