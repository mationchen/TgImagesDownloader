/**
 * Image URL resolver architecture (adopted from the ChatGPT V2 suggestion,
 * made spec-compliant — spec §25 / §2).
 *
 * Different Telegraph pages link images from different hosts:
 *   - telegra.ph/file/...          (Telegraph official hosting — public)
 *   - i.ibb.co/...                 (ImgBB public image host)
 *   - img.4khd.com/...             (3rd-party host behind a Cloudflare
 *                                    human-verification challenge — NOT
 *                                    directly downloadable)
 *   - arbitrary other https hosts
 *
 * Instead of the app knowing nothing about the source and failing, each URL
 * is passed through a chain of resolvers. A resolver either:
 *   - yields a directly-downloadable URL, or
 *   - reports that the host is blocked / needs a browser, so the UI can show
 *     a clear message instead of a generic download failure.
 *
 * We deliberately do NOT bypass Cloudflare challenges / captchas — that would
 * violate spec §25 (access control) and §2 (do not bypass CAPTCHAs). The
 * "blocked" outcome tells the user to view such images in a browser/Telegram.
 */

export type ResolverResult =
  | { kind: 'direct'; url: string }
  | { kind: 'blocked'; code: string; message: string };

export interface ImageResolver {
  /** Short identifier, e.g. 'telegraph-native', '4khd'. */
  readonly name: string;
  /** True when this resolver owns the given image URL. */
  canHandle(url: string): boolean;
  /** Produce a downloadable URL or report a blocked host. */
  resolve(url: string): ResolverResult;
}

/** Error code when a host is recognised as protected/blocked. */
export const ERR_BLOCKED_HOST = 'ERR_BLOCKED_HOST';
export const ERR_BLOCKED_HOST_4KHD = 'ERR_BLOCKED_HOST_4KHD';
