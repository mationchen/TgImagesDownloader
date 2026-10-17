/**
 * Decode HTML character references in scraped text.
 *
 * Titles come straight from `<title>` / `og:title`, and sites happily put raw
 * markup in them — `&#8211;` (an en dash) is extremely common, e.g.
 * `Cosplay Bangni &#8211; Eviera.club`. Without decoding, that literal text ends
 * up in 下载记录 and looks broken.
 *
 * Used in two places on purpose:
 *   - the parser, so newly saved rows are clean;
 *   - the UI, because rows saved before this existed still hold the raw text.
 */

/** Named references worth covering (the ones real titles actually use). */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  horbar: '\u2015',
  hellip: '\u2026',
  middot: '\u00b7',
  bull: '\u2022',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  sbquo: '\u201a',
  bdquo: '\u201e',
  prime: '\u2032',
  Prime: '\u2033',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  minus: '\u2212',
  deg: '\u00b0',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  frasl: '\u2044',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  '100': '\u00b7', // some CMSes emit this for a bullet
};

/** `&#8211;` / `&#x2013;` / `&ndash;` → the real character. */
export function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf('&') === -1) return input;
  return input.replace(
    /&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, body: string) => {
      if (body.charAt(0) === '#') {
        const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        const code = parseInt(
          isHex ? body.slice(2) : body.slice(1),
          isHex ? 16 : 10,
        );
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
          return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return NAMED[body] ?? NAMED[body.toLowerCase()] ?? match;
    },
  );
}
