import type {SiteAdapter} from './types';

/**
 * WordPress adapter: covers everia.club and other WP-based galleries.
 * WP renders pagination as page-links or ?page=/paged param and marks
 * related-post cards with `fifu-featured` / `post-id`.
 */
export class WordPressAdapter implements SiteAdapter {
  readonly name = 'wordpress';

  canHandle(_url: string, html?: string): boolean {
    if (!html) return false;
    // Heuristics: WP generator tag, wp-content / wp-includes paths, page-links class
    return (
      /<meta[^>]+name=["']generator["'][^>]+WordPress/i.test(html) ||
      /\/wp-content\//i.test(html) ||
      /\/wp-includes\//i.test(html) ||
      /class=["'][^"']*page-links[^"']*["']/i.test(html)
    );
  }

  paginationUrls(): string[] {
    // Defer to the generic collector in telegraphParser (which already handles
    // /2/ and ?page=). Returning empty here signals "use generic".
    return [];
  }
}

export const wordPressAdapter = new WordPressAdapter();
