import type { ImageResolver, ResolverResult } from './types';

/**
 * Telegraph official image hosting (telegra.ph/file/...). These are public
 * and directly downloadable — the common case.
 */
export class TelegraphNativeResolver implements ImageResolver {
  readonly name = 'telegraph-native';

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'telegra.ph';
    } catch {
      return false;
    }
  }

  resolve(url: string): ResolverResult {
    return { kind: 'direct', url };
  }
}
