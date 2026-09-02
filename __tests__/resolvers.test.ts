import {TelegraphNativeResolver} from '../src/services/resolvers/telegraphNativeResolver';
import {ImgBBResolver} from '../src/services/resolvers/imgbbResolver';
import {BlockedHostResolver} from '../src/services/resolvers/blockedHostResolver';
import {GenericResolver} from '../src/services/resolvers/genericResolver';
import {ResolverRegistry} from '../src/services/resolvers/registry';

describe('TelegraphNativeResolver', () => {
  const r = new TelegraphNativeResolver();
  it('handles telegra.ph/file URLs', () => {
    expect(
      r.canHandle('https://telegra.ph/file/abc123.jpg'),
    ).toBe(true);
  });
  it('does not handle other hosts', () => {
    expect(r.canHandle('https://img.4khd.com/x.webp')).toBe(false);
    expect(r.canHandle('https://i.ibb.co/x.png')).toBe(false);
  });
  it('resolves to the same URL directly', () => {
    const url = 'https://telegra.ph/file/abc.jpg';
    expect(r.resolve(url)).toEqual({kind: 'direct', url});
  });
});

describe('ImgBBResolver', () => {
  const r = new ImgBBResolver();
  it('handles i.ibb.co', () => {
    expect(r.canHandle('https://i.ibb.co/bYwH4Y2/photo.png')).toBe(true);
  });
  it('resolves direct', () => {
    const url = 'https://i.ibb.co/x/y.png';
    expect(r.resolve(url)).toEqual({kind: 'direct', url});
  });
});

describe('BlockedHostResolver', () => {
  const r = new BlockedHostResolver();
  it('detects img.4khd.com', () => {
    expect(
      r.canHandle('https://img.4khd.com/-JHpNdzRqjHU/x.webp'),
    ).toBe(true);
  });
  it('reports blocked with the 4KHD error code', () => {
    const res = r.resolve('https://img.4khd.com/x.webp');
    expect(res.kind).toBe('blocked');
    if (res.kind === 'blocked') {
      expect(res.code).toBe('ERR_BLOCKED_HOST_4KHD');
      expect(res.message.length).toBeGreaterThan(0);
    }
  });
  it('does not handle public hosts', () => {
    expect(r.canHandle('https://telegra.ph/file/x.jpg')).toBe(false);
    expect(r.canHandle('https://i.ibb.co/x.png')).toBe(false);
  });
});

describe('GenericResolver', () => {
  const r = new GenericResolver();
  it('handles any https URL', () => {
    expect(r.canHandle('https://example.com/img.webp')).toBe(true);
  });
  it('rejects non-http schemes', () => {
    expect(r.canHandle('file:///etc/x')).toBe(false);
    // eslint-disable-next-line no-script-url
    expect(r.canHandle('javascript:alert(1)')).toBe(false);
  });
  it('resolves direct', () => {
    const url = 'https://cdn.example.com/x.jpg';
    expect(r.resolve(url)).toEqual({kind: 'direct', url});
  });
});

describe('ResolverRegistry', () => {
  it('routes 4KHD URLs to the blocked resolver', () => {
    const reg = new ResolverRegistry();
    const res = reg.resolve('https://img.4khd.com/-x/y.webp');
    expect(res.kind).toBe('blocked');
  });
  it('routes Telegraph URLs to direct', () => {
    const reg = new ResolverRegistry();
    const res = reg.resolve('https://telegra.ph/file/abc.jpg');
    expect(res.kind).toBe('direct');
  });
  it('routes imgbb URLs to direct', () => {
    const reg = new ResolverRegistry();
    expect(reg.resolve('https://i.ibb.co/a/b.png').kind).toBe('direct');
  });
  it('routes unknown https hosts to generic (direct)', () => {
    const reg = new ResolverRegistry();
    expect(reg.resolve('https://cdn.other.com/x.gif').kind).toBe('direct');
  });
});