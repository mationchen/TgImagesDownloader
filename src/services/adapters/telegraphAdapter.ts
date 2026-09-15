import type { SiteAdapter } from './types';

/**
 * Telegraph adapter: telegra.ph pages are single-page with a predictable
 * article body. No pagination.
 */
export class TelegraphAdapter implements SiteAdapter {
  readonly name = 'telegraph';

  canHandle(url: string): boolean {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'telegra.ph' || h === 'www.telegra.ph';
    } catch {
      return false;
    }
  }

  paginationUrls(): string[] {
    return [];
  }

  // No custom extraction — generic pipeline already covers <img> inside
  // Telegraph's article body. Keep it simple to avoid divergence.
  extractImages?: undefined;
}

export const telegraphAdapter = new TelegraphAdapter();
