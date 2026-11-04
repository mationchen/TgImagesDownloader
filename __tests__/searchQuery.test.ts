import {
  escapeLikePattern,
  likeContainsPattern,
  tagJsonFragment,
} from '../src/utils/searchQuery';

describe('escapeLikePattern', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('Cosplay 三無人型')).toBe('Cosplay 三無人型');
  });

  it('escapes SQL wildcards and the escape character itself', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('C:\\tmp')).toBe('C:\\\\tmp');
  });
});

describe('likeContainsPattern', () => {
  it('wraps the trimmed value in wildcards', () => {
    expect(likeContainsPattern('  kanna ')).toBe('%kanna%');
  });

  it('treats whitespace-only input as "no filter"', () => {
    expect(likeContainsPattern('   ')).toBe('');
    expect(likeContainsPattern('')).toBe('');
  });

  it('keeps escaped wildcards literal', () => {
    expect(likeContainsPattern('50%')).toBe('%50\\%%');
  });
});

describe('tagJsonFragment', () => {
  it('quotes the tag so prefixes do not match', () => {
    expect(tagJsonFragment('cat')).toBe('"cat"');
  });

  it('escapes quotes and backslashes used by JSON', () => {
    expect(tagJsonFragment('a"b')).toBe('"a\\"b"');
    expect(tagJsonFragment('a\\b')).toBe('"a\\\\b"');
  });
});
