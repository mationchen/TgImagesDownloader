import type { ImageResolver, ResolverResult } from './types';

/**
 * ImgBB public image host (i.ibb.co/...). Publicly downloadable.
 */
export class ImgBBResolver implements ImageResolver {
  readonly name = 'imgbb';

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'i.ibb.co' || host.endsWith('.ibb.co');
    } catch {
      return false;
    }
  }

  resolve(url: string): ResolverResult {
    return { kind: 'direct', url };
  }
}
