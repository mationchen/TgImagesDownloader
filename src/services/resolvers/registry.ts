import { TelegraphNativeResolver } from './telegraphNativeResolver';
import { ImgBBResolver } from './imgbbResolver';
import { BlockedHostResolver } from './blockedHostResolver';
import { GenericResolver } from './genericResolver';
import type { ImageResolver, ResolverResult } from './types';

/**
 * Registry that tries resolvers in priority order for a given URL.
 * Order matters: specific/public resolvers first, blocked-host detection,
 * then the generic fallback last.
 */
export class ResolverRegistry {
  private resolvers: ImageResolver[];

  constructor(resolvers?: ImageResolver[]) {
    this.resolvers = resolvers ?? [
      new TelegraphNativeResolver(),
      new ImgBBResolver(),
      new BlockedHostResolver(),
      new GenericResolver(),
    ];
  }

  /**
   * Resolve a URL to a downloadable URL or a "blocked" outcome using the
   * first resolver that claims it.
   */
  resolve(url: string): ResolverResult {
    for (const r of this.resolvers) {
      if (r.canHandle(url)) {
        return r.resolve(url);
      }
    }
    // Unreachable given the generic fallback, but keep it safe.
    return { kind: 'direct', url };
  }
}

/** Default shared instance. */
export const defaultResolverRegistry = new ResolverRegistry();

export type { ImageResolver, ResolverResult };
