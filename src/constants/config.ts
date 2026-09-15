export const APP_CONFIG = {
  appName: 'Web Image Batch Downloader',
  appNameZh: '网页图片批量下载器',

  // Telegraph page fetch limits
  telegraph: {
    connectTimeoutMs: 10_000,
    readTimeoutMs: 30_000,
    maxRetries: 2,
    // Max HTML size we'll read into memory (~ 5 MiB). Telegraph articles
    // rarely exceed this, but we cap it to avoid OOM on adversarial pages.
    maxResponseBytes: 5 * 1024 * 1024,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; TelegraphDownloader/0.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  },

  // Future phases
  download: {
    // Downloads to this class of image CDN are latency-bound (long time to
    // first byte, near-instant body). A higher default concurrency keeps more
    // connections in flight so a few slow-TTFB responses don't serialise the
    // whole batch. The queue gates actual parallelism via getConcurrency().
    defaultConcurrency: 8,
    concurrencyOptions: [1, 2, 3, 5, 8] as const,
    defaultMaxRetries: 3,
    defaultSaveDir: 'Pictures/TelegraphDownloader',
    // Hard upper bound for a single image download (TTFB + body). Kept above
    // the page read timeout because image CDNs can stall on first byte for
    // tens of seconds yet still succeed — aborting too early (e.g. at 30s)
    // made slow-but-valid images fail and then burn retries re-downloading.
    fetchTimeoutMs: 90_000,
  },

  // 关于 (About) section on the Settings tab. Studio / website / contact are
  // proper nouns and intentionally NOT localized.
  about: {
    studio: 'Alexandia Chen Studio',
    websiteLabel: 'acstd.com',
    websiteUrl: 'https://acstd.com',
    contactEmail: 'alexandiachen@gmail.com',
  },

  i18n: {
    defaultLocale: 'zh-CN' as const,
    supportedLocales: ['zh-CN', 'en'] as const,
  },
};

export type SupportedLocale = (typeof APP_CONFIG.i18n.supportedLocales)[number];
