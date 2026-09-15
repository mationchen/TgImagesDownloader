import { genericAdapter } from './genericAdapter';
import { telegraphAdapter } from './telegraphAdapter';
import { TuzacAdapter } from './tuzacAdapter';
import { wordPressAdapter } from './wordPressAdapter';
import type { SiteAdapter } from './types';

export class AdapterRegistry {
  private adapters: SiteAdapter[];

  constructor(adapters?: SiteAdapter[]) {
    this.adapters = adapters ?? [
      telegraphAdapter,
      new TuzacAdapter(),
      wordPressAdapter,
      genericAdapter,
    ];
  }

  /**
   * Resolve the first adapter that handles this URL/HTML.
   * When `html` is not yet fetched, adapters that require HTML will return
   * false and the next one is tried — ensures we never block on fetch.
   */
  resolve(url: string, html?: string): SiteAdapter {
    for (const a of this.adapters) {
      if (a.canHandle(url, html)) return a;
    }
    return genericAdapter;
  }

  /** Expose the underlying list for tests/introspection. */
  list(): SiteAdapter[] {
    return [...this.adapters];
  }
}

export const defaultAdapterRegistry = new AdapterRegistry();

export type { SiteAdapter } from './types';
