import {
  type ImageResolver,
  type ResolverResult,
  ERR_BLOCKED_HOST_4KHD,
} from './types';

/**
 * Known hosts that protect images behind a Cloudflare human-verification
 * challenge and are therefore NOT directly downloadable (verified for
 * `img.4khd.com`, which 302-redirects to a JS challenge + dynamic mirror
 * selection). We report a blocked outcome rather than bypassing the CAPTCHA
 * (spec §25 / §2).
 *
 * Add more hosts here as they are discovered.
 */
const BLOCKED_HOSTS: Record<string, string> = {
  'img.4khd.com': ERR_BLOCKED_HOST_4KHD,
  '4khd.com': ERR_BLOCKED_HOST_4KHD,
};

export class BlockedHostResolver implements ImageResolver {
  readonly name = 'blocked-host';

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host in BLOCKED_HOSTS || BLOCKED_HOSTS[host] !== undefined;
    } catch {
      return false;
    }
  }

  resolve(url: string): ResolverResult {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const code = BLOCKED_HOSTS[host] ?? ERR_BLOCKED_HOST_4KHD;
      return {
        kind: 'blocked',
        code,
        message: `Host ${host} blocks direct access (human-verification challenge)`,
      };
    } catch {
      return {
        kind: 'blocked',
        code: ERR_BLOCKED_HOST_4KHD,
        message: 'Source host blocks direct access',
      };
    }
  }
}
