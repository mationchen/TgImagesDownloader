# Telegraph Image Batch Downloader — AI-DEV-SPEC

> 项目类型：Android 原生 App / React Native
> 项目代号：Telegraph Downloader
> 文档用途：供 AI Coding Agent（Codex / Claude Code / Qwen Code / Kimi Code / OpenCode 等）直接读取并执行开发
> 当前目标：先完成可运行、稳定的 MVP，再逐步增强
> 更新时间：2026-09-01

---

## 1. 项目目标

开发一款 Android App，用于批量解析并下载 `telegra.ph` Telegraph 文章页面中的图片。

典型输入：

```text
https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17
```

App 应自动：

1. 获取 Telegraph 页面 HTML。
2. 解析页面中的所有图片。
3. 展示图片数量及缩略图。
4. 用户确认后批量下载。
5. 显示整体及单张下载进度。
6. 下载失败自动重试。
7. 已下载文件自动跳过。
8. 将图片保存到 Android 用户可访问的位置。
9. 支持多个 Telegraph 链接批量处理。

第一阶段只处理公开的 `https://telegra.ph/` 页面，不要求 Telegram 登录，不处理私有资源，不绕过访问控制。

---

# 2. MVP 范围

## 2.1 必须实现

### 输入

- 单个 Telegraph URL
- 多个 Telegraph URL
- 从剪贴板自动识别 URL
- 粘贴文本后自动提取其中的 Telegraph URL
- 支持 Share Intent：
  - 从浏览器分享 URL 到 App
  - App 自动填充 URL

### 解析

- 获取 Telegraph HTML
- 解析文章标题
- 解析文章中的图片 URL
- 去重
- 保留图片原始 URL
- 显示图片总数
- 解析失败时显示明确错误

### 预览

- 图片缩略图 Grid
- 显示序号
- 显示解析状态
- 点击缩略图查看大图
- 支持全选/取消全选

### 下载

- 批量下载
- 下载进度
- 单张下载状态
- 成功/失败/跳过统计
- 失败自动重试
- 暂停
- 继续
- 取消
- 已存在文件跳过
- 下载完成通知

### 文件

默认目录：

```text
Pictures/TelegraphDownloader/
```

推荐按文章建立子目录：

```text
Pictures/
└── TelegraphDownloader/
    └── {article-title}/
        ├── 001.jpg
        ├── 002.jpg
        ├── 003.jpg
        └── ...
```

如果 Android 版本及存储框架允许，应优先使用 MediaStore / SAF，而不是直接依赖传统外部存储路径。

### 历史记录

保存：

- URL
- 标题
- 图片数量
- 成功数量
- 失败数量
- 创建时间
- 下载目录
- 最后状态

---

# 3. 非目标

MVP 不实现：

- Telegram 账号登录
- Telegram 私有频道下载
- 绕过登录/权限/验证码
- DRM 破解
- 付费墙绕过
- 代理池
- CAPTCHA 自动破解
- 视频下载
- 音频下载
- 爬取搜索引擎
- 自动发现未知 Telegraph 页面
- 云端账号系统
- 用户上传服务器
- 广告 SDK

后续版本可以根据合法使用场景增加其他公开媒体格式。

---

# 4. 技术要求

## 4.1 推荐技术栈

如果已有 React Native 开发环境：

```text
React Native
TypeScript
Android
Gradle
Kotlin / Java Native Module（仅在 RN JS 能力不足时使用）
```

推荐：

```text
React Native >= 0.80
TypeScript
Android SDK 36
compileSdk 36
targetSdk 36
minSdk 24
```

但必须以项目当前实际 RN 版本和依赖兼容性为准，不要为了本项目无理由升级整个 RN 工程。

---

# 5. 推荐架构

```text
src/
├── app/
│   ├── App.tsx
│   └── navigation/
│
├── screens/
│   ├── HomeScreen.tsx
│   ├── PreviewScreen.tsx
│   ├── DownloadScreen.tsx
│   ├── HistoryScreen.tsx
│   └── SettingsScreen.tsx
│
├── components/
│   ├── UrlInput.tsx
│   ├── ImageGrid.tsx
│   ├── DownloadProgress.tsx
│   ├── DownloadItem.tsx
│   └── EmptyState.tsx
│
├── services/
│   ├── telegraphParser.ts
│   ├── imageDownloader.ts
│   ├── clipboardService.ts
│   ├── shareIntentService.ts
│   └── storageService.ts
│
├── store/
│   ├── downloadStore.ts
│   └── historyStore.ts
│
├── types/
│   ├── telegraph.ts
│   └── download.ts
│
├── utils/
│   ├── url.ts
│   ├── filename.ts
│   ├── mime.ts
│   └── retry.ts
│
└── constants/
    └── config.ts
```

---

# 6. 核心数据结构

## TelegraphArticle

```ts
interface TelegraphArticle {
  url: string;
  title: string;
  images: TelegraphImage[];
  parsedAt: number;
}
```

## TelegraphImage

```ts
interface TelegraphImage {
  id: string;
  index: number;
  url: string;
  filename: string;
  mimeType?: string;
  width?: number;
  height?: number;
  selected: boolean;
}
```

## DownloadTask

```ts
type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled';

interface DownloadTask {
  id: string;
  image: TelegraphImage;
  status: DownloadStatus;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  retryCount: number;
  localPath?: string;
  error?: string;
}
```

---

# 7. Telegraph 页面解析

## 7.1 URL 校验

只允许：

```text
https://telegra.ph/*
http://telegra.ph/*
```

生产版本可以考虑允许：

```text
https://telegra.ph/*
```

作为唯一正式格式。

拒绝：

```text
javascript:
file:
content:
任意未知域名
```

必须防止 SSRF 风险。

---

## 7.2 HTML 获取

MVP 可以直接从 Android App 发起 HTTPS GET 请求。

要求：

- 设置合理 User-Agent
- 设置 Connect Timeout
- 设置 Read Timeout
- 支持 gzip
- 正确处理 UTF-8
- HTTPS 优先
- 不无限重试

推荐：

```text
connect timeout: 10s
read timeout: 30s
retry: 2~3 次
```

---

## 7.3 图片解析

解析页面中的：

```html
<img src="...">
```

以及 Telegraph 常见图片节点。

必须：

1. 获取所有图片 URL
2. 转换相对 URL 为绝对 URL
3. 去重
4. 保持页面原始顺序
5. 不因某一张图片解析失败导致整个页面失败

---

# 8. 图片 URL 处理

典型 Telegraph 页面可能包含：

```text
https://telegra.ph/file/xxxxxxxx.jpg
```

或者其他公开 CDN 图片 URL。

不要假设所有图片域名都相同。

规则：

- 以页面实际 HTML 为准
- 不硬编码某个 CDN
- 下载时校验 HTTP 状态码
- 支持 HTTP Redirect
- 限制最终 URL 协议为 HTTP/HTTPS
- 对最终 URL 做安全校验

---

# 9. 文件命名

默认：

```text
001.jpg
002.jpg
003.jpg
```

如果能可靠取得原始文件名，可以保留原始文件名。

但必须防止：

```text
../
..
/
\
:
*
?
"
<
>
|
```

等非法字符。

文件名最大长度建议限制为 100~150 字符。

---

# 10. 下载引擎

## 10.1 并发

默认：

```text
concurrency = 3
```

设置中允许：

```text
1
2
3
5
8
```

不要默认 10+，避免手机网络、服务器和系统资源压力过大。

---

## 10.2 下载流程

```text
pending
   ↓
检查本地文件
   ↓
文件存在且校验通过
   ↓
skipped
```

否则：

```text
pending
   ↓
downloading
   ↓
success
```

失败：

```text
downloading
   ↓
failed
   ↓
retry
   ↓
downloading
```

达到最大重试次数：

```text
failed
```

---

# 11. 断点续传

MVP 可以暂不实现真正的 HTTP Range 断点续传。

第一版要求：

- 已完整存在的文件跳过
- 下载中断后删除不完整文件
- 重新下载

V2 再实现：

```http
Range: bytes=...
```

以及 `.part` 临时文件。

---

# 12. 下载文件校验

下载完成后至少验证：

- HTTP 状态为 2xx
- 文件大小 > 0
- 文件扩展名合理
- MIME 类型为 image/* 或允许的图片格式

不要仅仅因为文件名是 `.jpg` 就认为它是图片。

---

# 13. Android 存储

重点兼容：

```text
Android 7+
Android 10+
Android 11+
Android 12+
Android 13+
Android 14+
Android 15+
Android 16+
```

优先使用：

```text
MediaStore
```

保存到：

```text
Pictures/TelegraphDownloader/
```

如果用户选择自定义目录，使用：

```text
Storage Access Framework / ACTION_OPEN_DOCUMENT_TREE
```

避免依赖：

```text
MANAGE_EXTERNAL_STORAGE
```

除非确实有必要。

---

# 14. 权限

尽量减少权限。

网络：

```xml
android.permission.INTERNET
```

不要申请：

```text
READ_CONTACTS
CAMERA
LOCATION
MICROPHONE
```

对于新 Android 版本，使用 MediaStore 写入公共 Pictures 通常无需传统存储权限。

如果某个实现必须申请权限，必须根据 Android API Level 动态判断。

---

# 15. 页面设计

## 15.1 首页

页面：

```text
Telegraph Downloader

[ 粘贴 Telegraph 链接 ]

[解析]

最近使用
----------------
文章 A
文章 B
文章 C
```

支持：

- 自动读取剪贴板
- 清空输入
- URL 数量提示
- 粘贴多个 URL

---

# 16. 多 URL 输入

支持：

```text
https://telegra.ph/a
https://telegra.ph/b
https://telegra.ph/c
```

以及混合文本：

```text
这是一个页面：
https://telegra.ph/a

另外一个：
https://telegra.ph/b
```

通过正则提取 Telegraph URL。

---

# 17. 解析页面

显示：

```text
文章标题

图片数量：190

[全选] [全不选]

┌────┬────┬────┬────┐
│ 01 │ 02 │ 03 │ 04 │
├────┼────┼────┼────┤
│ 05 │ 06 │ 07 │ 08 │
└────┴────┴────┴────┘

[开始下载]
```

---

# 18. 图片预览

点击图片：

- 大图预览
- 左右滑动
- 当前序号
- 总数量

例如：

```text
12 / 190
```

图片加载失败：

```text
图片加载失败
[重试]
```

---

# 19. 下载页面

顶部：

```text
正在下载

123 / 190

████████████░░░░░

成功：118
失败：2
跳过：3
```

下面：

```text
001.jpg     ✓
002.jpg     ✓
003.jpg     ↓ 56%
004.jpg     等待
005.jpg     ✕
```

按钮：

```text
[暂停] [取消]
```

完成：

```text
下载完成

成功：188
失败：2
跳过：0

保存位置：
Pictures/TelegraphDownloader/xxx/

[打开文件夹]
[查看失败]
[返回首页]
```

---

# 20. 后台下载

MVP 最好支持 App 切到后台后继续下载。

Android 推荐：

- WorkManager
- Foreground Service

如果采用 Foreground Service：

必须正确实现 Android 新版本的前台服务限制和通知。

不要为了 MVP 引入复杂后台架构，优先保证稳定。

如果当前 RN 下载库无法稳定支持后台下载，可以：

1. JS 层实现前台批量下载
2. App 切后台时提示用户
3. V2 再实现真正后台下载

---

# 21. 通知

下载过程中显示：

```text
Telegraph Downloader

正在下载 45 / 190
```

完成：

```text
Telegraph Downloader

下载完成
190 张图片
```

失败：

```text
Telegraph Downloader

下载完成，但有 3 张失败
```

Android 13+ 正确处理通知权限。

---

# 22. 历史记录

历史页面：

```text
下载历史

今天
----------------
DJAWA Photo Vol.0378
190 张
2026-09-01 19:30

昨天
----------------
Article B
56 张
2026-08-31 21:10
```

点击历史：

- 查看文章
- 查看图片
- 重新下载失败项
- 删除历史记录

删除历史记录默认不删除已经下载的文件，除非用户明确选择。

---

# 23. 设置

设置项：

```text
下载设置
----------------
并发下载数：3
自动跳过已下载：开启
失败自动重试：3
下载完成通知：开启

保存设置
----------------
默认保存目录

界面
----------------
深色模式
跟随系统

其他
----------------
关于
隐私政策
开源许可
```

---

# 24. 错误处理

必须针对以下情况提供用户可理解的提示。

## URL 错误

```text
请输入有效的 Telegraph 链接
```

## 网络错误

```text
网络连接失败，请检查网络后重试
```

## 页面不存在

```text
Telegraph 页面不存在或无法访问
```

## 页面没有图片

```text
这个页面没有找到可下载的图片
```

## 图片下载失败

```text
图片下载失败
HTTP 404
```

不要向普通用户展示 Java Exception Stack Trace。

Debug 模式日志中保留详细错误。

---

# 25. 安全要求

这是一个下载器，因此必须重点防范：

## SSRF

只允许用户输入 Telegraph URL。

页面中的图片 URL 可以是第三方 CDN，但必须：

- 只允许 HTTP/HTTPS
- 禁止 localhost
- 禁止 127.0.0.1
- 禁止 0.0.0.0
- 禁止内网地址
- 禁止 file://
- 禁止 content://
- 禁止 data://
- 禁止 javascript://

生产版本需要进一步处理 DNS Rebinding 等 SSRF 风险。

---

# 26. 性能要求

目标：

- 190 张图片页面能够正常解析
- 不因为一次性加载 190 张原图导致 OOM
- Grid 使用缩略图/缓存
- 下载采用流式写文件
- 不把整个图片文件读入 JS 内存
- 大图不直接 `base64` 存储
- 下载过程中 UI 保持基本流畅

---

# 27. 大规模下载

必须考虑：

```text
10 张
100 张
500 张
1000 张
```

不能假设一个页面只有几十张图片。

对于 1000 张图片：

- 不一次性创建 1000 个并发 Promise
- 使用任务队列
- 控制并发
- 分批处理
- 正确释放资源

---

# 28. 网络异常

支持：

- Wi-Fi
- 移动网络
- 网络临时断开
- HTTP 429
- HTTP 403
- HTTP 404
- HTTP 5xx

建议：

```text
429 / 5xx
→ 指数退避重试

404
→ 不重试或最多 1 次

403
→ 提示访问被拒绝

网络断开
→ 等待网络恢复或允许用户手动继续
```

---

# 29. 日志

Debug 模式记录：

```text
[Parser] URL:
[Parser] HTTP status:
[Parser] image count:
[Download] start:
[Download] success:
[Download] failed:
[Download] retry:
```

Release 版本：

- 不记录敏感数据
- 不上传用户 URL
- 不上传图片
- 不包含 API Key

---

# 30. 隐私

MVP 原则：

> 所有解析和下载尽量在用户设备本地完成。

不要：

- 上传 Telegraph URL 到自己的服务器
- 上传图片
- 收集用户下载历史
- 收集 Telegram 账号
- 收集通讯录
- 收集定位

如果没有服务器，隐私政策可以明确说明：

```text
App 不要求用户注册账号。
App 不上传用户下载的图片。
App 不主动收集个人身份信息。
```

正式发布前仍需根据实际代码、SDK、应用商店政策编写最终隐私政策。

---

# 31. 第三方依赖原则

优先使用成熟、维护活跃的库。

不要为了一个小功能增加大型依赖。

推荐关注：

- HTTP Client
- HTML Parser
- Image Cache
- Navigation
- Local Storage

依赖必须：

1. 检查 RN 版本兼容性
2. 检查 Android API 兼容性
3. 检查 License
4. 尽量选择 MIT / Apache-2.0 等宽松许可证

---

# 32. 推荐实现方式

## HTML Parser

优先：

```text
JS HTML Parser
```

如果性能不足，再考虑 Native。

## HTTP

优先使用成熟 HTTP client。

## 图片缓存

使用成熟图片组件，不自行实现复杂缓存。

## 文件下载

如果 RN JS 层下载大量大文件不稳定，应使用：

```text
Android Native Module
```

实现：

```text
DownloadManager / OkHttp
```

然后通过 RN Bridge 把进度传给 JS。

---

# 33. 推荐 MVP 开发顺序

## Phase 1 — 项目骨架

任务：

- 创建 RN Android 项目
- TypeScript
- 基础导航
- 首页
- 基础 UI
- Android SDK 配置

验收：

```text
npm install
npx react-native run-android
```

能够正常启动。

---

## Phase 2 — Telegraph URL 解析

实现：

- URL 校验
- HTML 获取
- 图片 URL 提取
- 图片去重
- 标题提取

验收：

输入：

```text
https://telegra.ph/DJAWA-Photo-Vol0378-CocoPie-Swimming-Lessons-18-07-17
```

能够得到：

```text
title
images[]
```

图片数量应与页面实际图片数量基本一致。

---

## Phase 3 — 图片预览

实现：

- Grid
- 缩略图
- 选中状态
- 全选
- 取消全选
- 大图查看

---

## Phase 4 — 单张下载

先实现：

```text
一张图片
→ 下载
→ 保存
→ 相册可见
```

确认 Android 存储方案稳定后再做批量。

---

## Phase 5 — 批量下载

实现：

- Task Queue
- concurrency
- retry
- skip existing
- progress
- cancel

重点测试：

```text
10 张
100 张
190 张
500 张
```

---

## Phase 6 — 历史记录

实现：

- 本地数据库/Storage
- 下载记录
- 失败记录
- 删除记录

---

## Phase 7 — Share Intent

支持：

```text
Chrome
 ↓
分享
 ↓
Telegraph Downloader
 ↓
自动解析
```

---

## Phase 8 — 后台下载

如果 MVP 前台下载稳定，再实现：

- Foreground Service
- Notification
- App 切后台继续下载
- 完成通知

---

# 34. 测试用例

## TC-001

输入有效 Telegraph URL。

预期：

```text
解析成功
```

## TC-002

输入普通 URL。

预期：

```text
URL 不合法
```

## TC-003

输入不存在页面。

预期：

```text
页面不存在
```

## TC-004

页面包含 190 张图片。

预期：

```text
全部识别
```

## TC-005

下载 190 张图片。

预期：

```text
不会 OOM
```

## TC-006

下载过程中断网。

预期：

```text
任务失败/暂停
可以继续
```

## TC-007

已有图片。

预期：

```text
skip
```

## TC-008

服务器返回 500。

预期：

```text
自动重试
```

## TC-009

服务器返回 404。

预期：

```text
标记失败
```

## TC-010

Android 13+。

预期：

```text
正常保存
```

## TC-011

Android 15/16。

预期：

```text
正常运行
```

## TC-012

1000 张图片。

预期：

```text
任务队列正常
内存稳定
```

---

# 35. UI/UX 风格

整体：

```text
极简
干净
工具型
科技感
```

不需要复杂动画。

建议首页突出：

```text
粘贴链接
```

主操作按钮：

```text
解析图片
```

解析完成后突出：

```text
发现 190 张图片
```

下载页面突出：

```text
190 / 190
```

---

# 36. 国际化

代码从第一天支持 i18n。

至少准备：

```text
zh-CN
en
```

所有用户可见文本不要直接硬编码到组件中。

例如：

```ts
t('home.parse')
t('download.completed')
```

---

# 37. App 名称

开发代号：

```text
Telegraph Downloader
```

中文暂定：

```text
Telegraph 图片下载器
```

正式品牌名称后续再确定。

---

# 38. App Icon

MVP 使用简单图标：

```text
下载箭头
+
图片/照片元素
```

避免：

- Telegram 官方 Logo
- Telegraph 官方 Logo 的直接复制
- 可能产生商标混淆的设计

---

# 39. 商店发布前检查

### Android

- [ ] applicationId
- [ ] versionCode
- [ ] versionName
- [ ] targetSdk
- [ ] release signing
- [ ] ProGuard/R8
- [ ] 隐私政策
- [ ] Data Safety
- [ ] 应用图标
- [ ] 启动图
- [ ] 截图
- [ ] 应用描述

### Google Play

- [ ] 内容分级
- [ ] 数据安全声明
- [ ] 隐私政策 URL
- [ ] Target API 要求
- [ ] App Access 声明（如需要）

---

# 40. AI Coding Agent 执行规则

AI Agent 读取本文件后，应遵循以下规则。

## 规则 1

不要一次性生成大量未经验证的代码。

采用：

```text
分析
→ 实现
→ 编译
→ 测试
→ 修复
→ 再继续
```

---

## 规则 2

每完成一个 Phase，必须：

```text
npm / yarn 检查
TypeScript 检查
Android 编译
```

并报告：

```text
修改文件
完成内容
测试结果
剩余问题
```

---

## 规则 3

遇到依赖冲突时：

不要直接：

```text
--force
--legacy-peer-deps
```

作为最终解决方案。

优先：

```text
检查 RN 版本
检查 peerDependencies
选择兼容版本
```

---

## 规则 4

不要随意升级：

```text
React Native
React
Gradle
Android Gradle Plugin
Kotlin
```

除非当前项目无法满足要求。

---

## 规则 5

任何涉及 Android 存储、后台任务、权限的问题，必须考虑 Android API Level 差异。

---

## 规则 6

不要把大图片转成 Base64 在 JS 内长期保存。

---

## 规则 7

不要在 JS 中创建无限量并发下载。

必须使用任务队列。

---

## 规则 8

用户输入 URL 必须进行校验。

不得允许任意协议访问。

---

## 规则 9

如果第三方库无法稳定完成大文件下载：

优先实现 Android Native Module。

---

## 规则 10

MVP 优先稳定性，而不是功能数量。

---

# 41. Definition of Done

当以下条件全部满足时，MVP 才算完成：

- [ ] Android App 可以 Release 编译
- [ ] 可以输入 Telegraph URL
- [ ] 可以解析文章
- [ ] 可以识别全部图片
- [ ] 可以预览图片
- [ ] 可以选择图片
- [ ] 可以批量下载
- [ ] 支持下载进度
- [ ] 支持失败重试
- [ ] 支持跳过已下载文件
- [ ] 图片正确保存到系统可访问目录
- [ ] Android 13+ 正常
- [ ] Android 15/16 正常
- [ ] 190 张图片测试通过
- [ ] 500 张图片压力测试基本稳定
- [ ] 不出现明显内存泄漏
- [ ] App 重启后历史记录仍存在
- [ ] 分享 URL 可以进入 App
- [ ] 中文/英文界面可用
- [ ] Release 构建无明显警告/错误
- [ ] 不收集不必要的用户数据

---

# 42. 后续版本路线图

## V1.1

- 下载队列
- 更好的后台下载
- 自定义命名
- 自定义保存目录
- 下载历史增强

## V1.2

- 断点续传
- Wi-Fi/移动网络策略
- 下载速度
- 剩余时间
- 自动重试策略

## V1.3

- 支持 Telegraph 视频
- 支持更多公开媒体类型
- 批量导入 TXT/CSV
- 批量导入剪贴板

## V2.0

- 更完善的任务管理
- 下载规则
- 文件夹模板
- 多站点公开媒体解析框架

---

# 43. 第一阶段 AI 执行任务

AI Agent 不要直接跳到全部功能。

首先执行：

### Task 01

检查当前项目环境：

```text
Node
npm
React Native
Android SDK
Gradle
Java
Kotlin
```

输出版本。

### Task 02

检查项目现有目录和 package.json。

如果已有 RN 项目：

```text
优先在现有项目中开发
```

不要无理由创建新项目。

### Task 03

创建基础：

```text
HomeScreen
telegraphParser
types
```

### Task 04

实现 Telegraph URL 校验。

### Task 05

实现：

```text
fetch HTML
↓
parse title
↓
parse images
↓
deduplicate
```

### Task 06

添加一个开发测试按钮：

```text
测试解析
```

输入固定测试 URL。

### Task 07

确认能够正确获得：

```text
title
image count
image URLs
```

### Task 08

再继续开发图片 Grid。

---

# 44. AI Agent 第一轮执行提示词

将以下内容直接作为 AI Coding Agent 的初始任务：

```text
你现在是本项目的 Android / React Native Senior Engineer。

请读取项目根目录的 AI-DEV-SPEC.md。

不要一次性实现全部功能。

第一步只做项目环境审查和 Phase 1 + Phase 2。

要求：

1. 检查当前 Node、npm、Java、Android SDK、Gradle、React Native 版本。
2. 检查 package.json。
3. 检查现有 Android 工程。
4. 不要随意升级现有 React Native。
5. 不要随意修改无关依赖。
6. 根据 AI-DEV-SPEC.md 建立合理目录结构。
7. 实现 Telegraph URL 校验。
8. 实现 Telegraph HTML 获取。
9. 实现文章标题解析。
10. 实现页面图片 URL 解析。
11. 图片 URL 去重并保持原始顺序。
12. 首页提供 URL 输入框和“解析图片”按钮。
13. 解析成功后显示文章标题和图片数量。
14. 对网络错误、404、无图片等情况进行用户友好提示。
15. 所有 TypeScript 类型必须完整。
16. 不要使用任何绕过 Telegram/Telegraph 权限的技术。
17. 不要加入广告 SDK。
18. 不要加入用户账号系统。
19. 完成后执行 TypeScript 检查和 Android Debug 编译。
20. 最后报告：
   - 修改了哪些文件
   - 完成了什么
   - 编译是否成功
   - 当前已知问题
   - 下一步建议

如果发现现有项目存在编译错误，先修复与本项目直接相关的错误，再继续。
```

---

# 45. 开发原则总结

```text
简单
↓
稳定
↓
可测试
↓
可扩展
```

核心业务链：

```text
Telegraph URL
      ↓
URL Validator
      ↓
HTML Fetcher
      ↓
Telegraph Parser
      ↓
Article + Images
      ↓
Preview
      ↓
Download Queue
      ↓
Downloader
      ↓
MediaStore
      ↓
Download History
```

最终 MVP 的核心目标只有一句话：

> **让用户把一个 Telegraph 图集链接粘进 App，就能可靠地把里面的全部图片批量保存到 Android 手机。**
