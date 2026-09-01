import type {ZhKeys} from './zh-CN';

export const en: Record<ZhKeys, string> = {
  'home.title': 'Telegraph Image Downloader',
  'home.subtitle':
    'Paste Telegraph links to batch-save images to your device',
  'home.inputPlaceholder':
    'Paste Telegraph link(s), one per line. Multiple links supported.',
  'home.parse': 'Parse images',
  'home.parseShort': 'Parse',
  'home.clear': 'Clear',
  'home.detectedUrls': '{count} link(s) detected',
  'home.recent': 'Recent',
  'home.recentEmpty': 'No history yet',

  'preview.title': 'Article title',
  'preview.imageCount': 'Image count: {count}',
  'preview.selectAll': 'Select all',
  'preview.deselectAll': 'Deselect all',
  'preview.invertSelection': 'Invert',
  'preview.startDownload': 'Start download',
  'preview.startDownloadHint': '(wired in Phase 4)',
  'preview.viewerIndex': '{current} / {total}',
  'preview.imageLoadFailed': 'Image failed to load',
  'preview.imageProbe': 'Check cause',
  'preview.imageProbeOk': 'Image host is reachable, please retry.',
  'preview.imageProbeHotlink':
    'Image host blocks direct access (anti-hotlink). Please view in Telegram.',
  'preview.imageProbeHttp': 'Image host returned an error (HTTP {status}).',
  'preview.imageProbeNetwork': 'Network failed while reaching the image host.',
  'preview.backToHome': 'Back to home',

  'download.preparing': 'Preparing…',
  'download.streaming': 'Downloading…',
  'download.saving': 'Saving to gallery…',
  'download.success': 'Saved to gallery',
  'download.failed': 'Download failed',
  'download.skipped': 'Skipped (already exists)',
  'download.pathHint': 'Saved to: Pictures/TelegraphDownloader/',

  'download.title': 'Downloading',
  'download.close': 'Close',
  'download.downloading': 'Downloading',
  'download.done': 'Done',
  'download.paused': 'Paused',
  'download.pause': 'Pause',
  'download.resume': 'Resume',
  'download.cancelAll': 'Cancel',
  'download.backToHome': 'Back to home',
  'download.noTasks': 'No tasks',
  'download.retryFailed': 'Retry failed ({count})',
  'download.activeCount': '{count} downloading in parallel…',

  'download.itemSuccess': 'Done',
  'download.itemFailed': 'Failed',
  'download.itemSkipped': 'Skipped',
  'download.itemCancelled': 'Cancelled',
  'download.itemPaused': 'Paused',
  'download.itemWaiting': 'Waiting',
  'download.itemProgress': '{percent}%',
  'download.itemHotlink': 'Hotlink blocked',
  'download.hotlinkExplain':
    'Some images are blocked by the source host. Please view in Telegram.',

  'history.title': 'Download history',
  'history.empty': 'No download history yet',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.groupFormat': '{date}',
  'history.itemCount': '{count} images',
  'history.viewAll': 'View all history',
  'history.reparse': 'Re-parse',
  'history.delete': 'Delete record',
  'history.cancel': 'Cancel',
  'history.reparseHint': 'Re-parse this article',
  'history.deleteConfirmTitle': 'Delete record',
  'history.deleteConfirmMsg':
    'This removes the history entry but does NOT delete the downloaded image files.',
  'history.deleteConfirmOk': 'Delete',
  'history.timeFormat': '{time}',

  'privacy.title': 'Privacy Policy',
  'privacy.link': 'Privacy policy',
  'privacy.intro':
    'All parsing, downloading and history in this app happens on your own device.',
  'privacy.noAccount': 'This app does not require you to create an account.',
  'privacy.noUpload':
    'This app does not upload images you download, and does not send your Telegraph links to any server (except contacting telegra.ph directly to fetch article content).',
  'privacy.noCollect':
    'This app does not collect personal identity information, contacts, location, or Telegram account data.',
  'privacy.localHistory':
    'Download history is stored only in the on-device database and is not uploaded.',
  'privacy.permissions':
    'This app requests notification permission (to show download progress) and clipboard access (only to recognize links you paste).',
  'privacy.contact':
    'If you have questions about this privacy policy, please contact us through the app store or developer channels.',

  'error.invalidUrl': 'Please enter a valid Telegraph link',
  'error.empty': 'Please enter a link',
  'error.network': 'Network failed. Please check your connection and retry.',
  'error.timeout': 'Network timed out. Please check your connection and retry.',
  'error.httpNotFound': 'Telegraph page not found or inaccessible.',
  'error.httpForbidden': 'Telegraph page access denied.',
  'error.httpServerError': 'Telegraph server error. Please retry later.',
  'error.parseError': 'Failed to parse the page.',
  'error.noImages': 'No downloadable images found on this page.',
  'error.responseTooLarge': 'Page is too large to process.',
  'error.unknown': 'Unknown error. Please retry.',

  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
};
