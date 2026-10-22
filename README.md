# 网页图片批量下载器（TgImagesDownloader）

把「一个网页里的一大堆图片」一次性下载进手机相册的 Android App。
基于 React Native 开发，除批量下载外还支持**下载记录管理**与**本地压缩包解压导入**。

| 项 | 值 |
|---|---|
| 应用名 | 网页图片批量下载器（debug 版显示为「网页图片批量下载器 Debug」，方便区分） |
| 包名 | `com.acstd.tgimagesdownloader`（release 变体为 `… .release`，可与调试版共存） |
| 当前版本 | 1.0.13（versionCode 13） |
| 平台 | Android 优先；iOS 暂为 no-op |

## 功能

### 1. 批量下载

- 粘贴一个或多个网页链接，逐个解析出图片并下载；也可用「选择 url.txt」批量导入
- 已下载过的链接 / 图片自动跳过，可一键重新排队
- 支持多站点适配器（`src/services/adapters`）与图片地址解析器（`src/services/resolvers`）
- 进度可见：暂停 / 继续 / 跳过当前 / 取消全部
- 后台保活：前台服务 + WakeLock / WifiLock + JS 心跳，切到后台继续下载
- 未连接 Wi-Fi 时下载前给出提示

### 2. 下载记录

- 列表：状态筛选、日期筛选、下拉刷新；下载完成后切回该页会自动刷新
- 列表每行显示图集**首图缩略图**，收藏的带 ★、标了删除的带「待删除」
- 有失败时显示「成功 X / 总数 Y」
- 详情页：图片网格、大图查看（可缩放）、左右滑动切换相邻记录；大图按需挂载
  （先出当前这张，再铺开左右各 2 页），图集有几百张也不会黑屏卡顿
- **收藏**（详情页 ★）与「**只看收藏**」筛选（列表 ★ 按钮）
- **标记为删除**（详情页 🏷）→ 列表顶部会出现「🗑 移入回收站（N）」一键移入；
  移入后不再出现在下载记录里
- **长按图片进入排序模式**，拖动即可人工调整顺序（松手自动存库）——用于把本该相邻的
  两张图（如一张完整图被拆成两半）挪到一起
- 标题里的 HTML 转义字符（如 `&#8211;`）会自动还原成正常符号
- 支持「重新解析」（链接失效时重跑）与「删除」（可选择连带删除相册文件）

### 2.1 回收站（设置页）

- 「设置 → 回收站」列出所有被移入的记录，可**单条恢复**回下载记录
- **一键清空**：删除记录 + 连带删除相册里的图片 + 清理下载台账（不可撤销）

### 3. 解压压缩包导入（本地）

- 批量下载页「选择压缩包」进入**应用内压缩包浏览页**
  - 只列出压缩包；支持按名称 / 时间排序、已解压标记、一键隐藏已解压项
  - 首次需授权一次目录：系统禁止授权 `Download` 根目录，请选里面的子文件夹
- 支持格式：**zip / 7z / tar / tar.gz(.tgz) / rar（含 RAR5）/ cbz / cbr**
- 按**内容指纹**去重：同一个包改名后再选（`xxx.zip` / `xxx (1).zip`）会被识别为已解压
- 解压结果统一放到共享目录，**不建任何子目录**（避免相册自动生成大量相簿）
- 归档内的**视频**会导入视频相册，详情页显示首帧缩略图，点击调用系统播放器播放
- 加密包、损坏包、超大包（> 4 GB）与条目过多（> 2 万）都会给出明确原因

### 4. 其他

- 多语言：简体中文（默认）/ English
- 设置：保存位置（Pictures / Download / 自定义 SAF 目录）、命名规则、并发数、重试次数
- 隐私政策页

## 技术栈

| 项 | 选型 |
|---|---|
| 框架 | React Native 0.87.1 + React 19.2.3（Hermes + New Architecture） |
| 语言 | TypeScript 6 |
| 导航 | `@react-navigation`（bottom-tabs + native-stack） |
| 本地存储 | `@op-engineering/op-sqlite`（SQLite，schema 按版本号迁移） |
| 下载 | `react-native-blob-util` + 原生 OkHttp 模块 |
| 相册 | `@react-native-camera-roll/camera-roll` + 原生 MediaStore 模块 |
| 压缩包 | `commons-compress` + `xz`（zip / 7z / tar）、`libarchive`（RAR5） |
| 国际化 | `src/i18n`（轻量字典，统一走 `t(key)`） |

## 目录结构

```
src/
  app/          应用外壳
  components/   通用组件（含 ArchivePicker 压缩包浏览页）
  constants/    常量与默认配置
  i18n/         多语言字典（zh-CN / en）
  navigation/   路由（底部 Tab + 根 Stack）
  screens/      页面
  services/     业务服务（解析 / 下载 / 记录 / 压缩包 / 设置）
  store/        全局状态
  theme/        主题与配色
  types/        类型定义
  utils/        工具函数
android/        Android 原生工程（Kotlin 模块在 app/src/main/java/...）
__tests__/      Jest 单元测试
开发相关资源/    指令日志等开发资料 + 图片链接提取器小工具（不参与构建）
```

## 小工具（不参与 App 构建）

### 图片链接提取器（在 `开发相关资源/`）

| 文件 | 用途 |
|---|---|
| `图片链接提取器.html` | 工具本体，双击用浏览器打开，无外部依赖 |
| `启动取页服务.cmd` | 「方式 B」联网抓取用的本机中继，双击启动 |
| `fetch-server.js` | 上面那个中继的 Node 实现（由 .cmd 调用） |

**三种输出模式**（结果一行一个，可复制或导出 `.txt`）：

1. **图片的跳转链接**（默认）—— `<img>` 外层 `<a href>`，即「点图片后跳转到的页面」
2. **图片地址** —— `<img src>` / 懒加载属性 / `srcset` / CSS 背景图 / `og:image`
3. **页面全部链接** —— 所有 `a[href]`

**两种拿网页源码的方式**：

1. 页面按你填的网址生成一条 `curl` 命令（走本机代理存成 `page.html`），
   在 PowerShell 执行后在页面上选该文件 —— 不受跨域限制，最稳
2. **方式 B** 直接填网址抓取：先双击 `启动取页服务.cmd`
   （会占用 `127.0.0.1:8787`，Ctrl+C 或关窗口即停），页面会自动检测服务是否在跑。
   之所以要这个中继：浏览器同源策略不允许网页直接抓别的站点，而公共 CORS 代理
   （allorigins / codetabs / corsproxy.io）到 2026-10 基本已失效或需付费 key

图片模式下的过滤项：扩展名白名单、排除关键词（logo/icon/avatar…）、最小边长、去重，
以及「还原原图」（去掉 WordPress 的 `-300x200` 尺寸后缀）；链接模式只做去重。

## 开发命令

```sh
npm start                # 启动 Metro（占用 8081，建议在独立终端）
npm run android          # 构建并安装 debug 版
npm run apk:local        # 打 release（全部 ABI）并用 adb 覆盖安装，保留 App 数据
npm run apk:local:clean  # 同上，但先 gradle clean（改了原生依赖时用）
npm run ios              # iOS：首次需 bundle install && bundle exec pod install
npm run lint             # ESLint
npm test                 # Jest
npx tsc --noEmit         # 类型检查（没有独立 npm script）
npx prettier --write .   # 格式化
```

构建 release：

```sh
cd android
.\gradlew assembleRelease                              # 三个架构
.\gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a   # 只要 arm64，本地调试更快
```

产物在 `android/app/build/outputs/apk/release/`。

## 发布流程

1. 改 `android/app/build.gradle` 里的 `versionCode` / `versionName`
2. `.\gradlew assembleRelease`
3. `git add -A` → `git commit -m "…"` → `git push origin master`
4. `git tag vX.Y.Z` → `git push origin vX.Y.Z`
5. `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes> <三个 APK>`

## 注意事项

- **Android 权限**：Android 13+ 想读相册里由其他应用创建的图片 / 视频，需要
  `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`，详情页会按需申请。
- **iOS**：目前按 no-op 惯例处理，原生能力集中在 Android 侧实现。
- **数据库迁移**：`historyService` 的 schema 按版本号逐级累加迁移，改动前先读
  `AGENTS.md` 第 4 条。
- **共享目录**：所有下载与解压结果默认落在 `Pictures/TelegraphDownloader`
  （视频在 `Movies/TelegraphDownloader`），且不建子目录。
- **⚠️ `MainActivity.onCreate` 必须传 `null`**（`super.onCreate(null)`）：进程被系统回收后
  从最近任务切回时，系统会拿 `savedInstanceState` 重建 Activity，进而尝试恢复
  `react-native-screens` 的 Fragment，而它**明确禁止被恢复** → 直接闪退
  （`Screen fragments should never be restored.`）。传 `null` 丢弃系统状态、让 JS 干净重开。
  **不要"顺手修好"成 `super.onCreate(savedInstanceState)`**，那会把闪退放回来。

---

更细的开发约定（全局规则、i18n、数据库迁移、后台进程、提交习惯等）见 `AGENTS.md`。
