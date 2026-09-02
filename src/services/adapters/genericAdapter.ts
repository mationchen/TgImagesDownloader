import type {SiteAdapter} from './types';

/**
 * Generic adapter: fallback for any site not matched by a specific adapter.
 * It relies entirely on the generic `extractImages` + `collectPaginationUrls`
 * heuristics in telegraphParser.ts, so it never claims ownership explicitly —
 * the registry uses it as the last resort.
 */
export class GenericAdapter implements SiteAdapter {
  readonly name = 'generic';

  canHandle(): boolean {
    return true;
  }

  paginationUrls(): string[] {
    return [];
  }
}

export const genericAdapter = new GenericAdapter();
