export const zhCN = {
  // Home
  'home.title': 'Telegraph 图片下载器',
  'home.subtitle': '粘贴 Telegraph 链接，批量保存图片到本地',
  'home.inputPlaceholder': '粘贴 Telegraph 链接（一行一个，支持多链接）',
  'home.parse': '解析图片',
  'home.parseShort': '解析',
  'home.clear': '清空',
  'home.detectedUrls': '已识别链接：{count} 个',
  'home.recent': '最近使用',
  'home.recentEmpty': '暂无记录',

  // Preview (also used inline on HomeScreen result card — same data, same wording)
  'preview.title': '文章标题',
  'preview.imageCount': '图片数量：{count}',
  'preview.selectAll': '全选',
  'preview.deselectAll': '全不选',
  'preview.invertSelection': '反选',
  'preview.startDownload': '开始下载',
  'preview.startDownloadHint': '（Phase 4 接入）',
  'preview.viewerIndex': '{current} / {total}',
  'preview.imageLoadFailed': '图片加载失败',
  'preview.imageProbe': '检测原因',
  'preview.imageProbeOk': '图片源可正常访问，请重试',
  'preview.imageProbeHotlink': '图片源站禁止外部访问（防盗链），请从 Telegram 查看',
  'preview.imageProbeHttp': '图片源返回错误（HTTP {status}）',
  'preview.imageProbeNetwork': '网络连接失败，无法访问图片源',
  'preview.backToHome': '返回首页',

  // Download (Phase 4: single image inline; Phase 5: full screen)
  'download.preparing': '准备下载…',
  'download.streaming': '下载中…',
  'download.saving': '保存到相册…',
  'download.success': '已保存到相册',
  'download.failed': '下载失败',
  'download.skipped': '已跳过（文件已存在）',
  'download.pathHint': '保存位置：Pictures/TelegraphDownloader/',

  // Download screen (Phase 5)
  'download.title': '正在下载',
  'download.close': '关闭',
  'download.downloading': '正在下载',
  'download.done': '下载完成',
  'download.paused': '已暂停',
  'download.pause': '暂停',
  'download.resume': '继续',
  'download.cancelAll': '取消',
  'download.backToHome': '返回首页',
  'download.noTasks': '没有待下载任务',
  'download.retryFailed': '重试失败（{count}）',
  'download.activeCount': '{count} 个并行下载中…',

  // Per-task status
  'download.itemSuccess': '完成',
  'download.itemFailed': '失败',
  'download.itemSkipped': '跳过',
  'download.itemCancelled': '已取消',
  'download.itemPaused': '暂停',
  'download.itemWaiting': '等待',
  'download.itemProgress': '{percent}%',
  'download.itemHotlink': '源站防盗链',
  'download.hotlinkExplain': '部分图片被源站禁止外部访问，请从 Telegram 查看',

  // History (Phase 6)
  'history.title': '下载历史',
  'history.empty': '暂无下载历史',
  'history.today': '今天',
  'history.yesterday': '昨天',
  'history.groupFormat': '{date}',
  'history.itemCount': '{count} 张',
  'history.viewAll': '查看全部历史',
  'history.reparse': '重新解析',
  'history.delete': '删除记录',
  'history.cancel': '取消',
  'history.reparseHint': '重新解析该文章',
  'history.deleteConfirmTitle': '删除记录',
  'history.deleteConfirmMsg': '将删除这条历史记录，但不会删除已下载的图片文件。',
  'history.deleteConfirmOk': '删除',
  'history.timeFormat': '{time}',

  // Privacy (MVP §30 / §39)
  'privacy.title': '隐私政策',
  'privacy.link': '隐私政策',
  'privacy.intro':
    '本应用的所有解析、下载与历史记录均在你自己的设备上完成。',
  'privacy.noAccount': '本应用不要求用户注册账号。',
  'privacy.noUpload':
    '本应用不会上传你下载的图片，也不会将你的 Telegraph 链接发送到任何服务器（除直接访问 telegra.ph 获取文章内容外）。',
  'privacy.noCollect':
    '本应用不主动收集个人身份信息、通讯录、定位或 Telegram 账号信息。',
  'privacy.localHistory': '下载历史仅保存在设备本地数据库中，不上传云端。',
  'privacy.permissions':
    '本应用会请求通知权限（仅用于显示下载进度）和访问剪贴板（仅用于识别你粘贴的链接）。',
  'privacy.contact':
    '如对本隐私政策有疑问，请通过应用商店或开发者渠道联系我们。',

  // Errors
  'error.invalidUrl': '请输入有效的 Telegraph 链接',
  'error.empty': '请输入链接',
  'error.network': '网络连接失败，请检查网络后重试',
  'error.timeout': '网络连接超时，请检查网络后重试',
  'error.httpNotFound': 'Telegraph 页面不存在或无法访问',
  'error.httpForbidden': 'Telegraph 页面访问被拒绝',
  'error.httpServerError': 'Telegraph 服务器错误，请稍后重试',
  'error.parseError': '页面解析失败',
  'error.noImages': '这个页面没有找到可下载的图片',
  'error.responseTooLarge': '页面过大，暂不支持',
  'error.unknown': '未知错误，请重试',

  // Common
  'common.cancel': '取消',
  'common.retry': '重试',
  'common.loading': '加载中…',
} as const;

export type ZhKeys = keyof typeof zhCN;
