import type {ImageResolver, ResolverResult} from './types';

/**
 * Fallback for any other http(s) host we don't special-case. Tries a direct
 * download; if that fails the caller reports a generic error.
 */
export class GenericResolver implements ImageResolver {
  readonly name = 'generic';

  canHandle(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }

  resolve(url: string): ResolverResult {
    return {kind: 'direct', url};
  }
}
