# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-10-31 23:20`（本地时区） / 会话：分页改版、详情页稳定性、封面功能 |
| 分支 / 工作区 | `master` / 本轮改动未提交（见 §3） |
| 当前版本 | `1.0.18（versionCode 18）`，已构建并覆盖安装，**待发版** |
| 数据库 schema | **v6**（迁移在 `src/services/historyService.ts`，v6 新增 `cover_uri`） |
| 运行环境 | Node 22.23.2；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16（API 36） |

## 1. 这一轮的目标

修「第二页滑到底闪烁」「详情页再次崩溃」「失败图片留黑块」，并按用户要求把分页改成固定 50 条 + 页码跳转、加封面功能、锁竖屏。

## 2. 已完成（上次提交 `07b264e` 之后）

| 改动 | 涉及文件 | 怎么验证的 / 结果 |
|---|---|---|
| 列表分页：**取消「先 20 条、下滑追加」**，固定 50 条/页，翻页栏常显 | `HistoryScreen.tsx` | 打开即 `第 1-50 条`；下一页 `51-100`；末页 `851-876` |
| 页码快速跳转（第一页 / 最后一页 / 数字输入 / 可滚动列表） | `HistoryScreen.tsx`、i18n | `最后一页`→851-876；输入 `5`→201-250 |
| 页码弹窗改**居中**卡片（原来贴底会误触手势条） | 同上 | 截图确认卡片垂直居中 |
| 页码 `▾` 加大加粗 | 同上 | 层级里成为独立节点 `[777,468][797,528]` |
| **详情页崩溃（第二次）**：`removeViewAt: Unable to find parentView` | `HistoryDetailScreen.tsx` | 页面改为**常挂 + `active` 只控制图片加载**；连滑 60 页无崩溃，内存 425 MB 稳定 |
| 失败图片**从网格移除**（不留黑块），全屏查看器也排除 | 同上 | 网格格子连续无空洞；全屏显示 `1 / 30`（31 张里排除失败那张） |
| 失败数量并入「失败 N」徽章 + 点击弹说明 | 同上、i18n | 徽章实时从 `失败 0` → `失败 1`；弹窗标题「加载失败：1 张」 |
| 详情页「重新获取」加确认弹窗 | 同上、i18n | 点 🔄 → 「重新获取这篇图集？」+ 取消/重新解析 |
| **封面功能**：全屏「收藏 / 封面」文字按钮、`cover_uri` 列、列表/回收站缩略图优先用封面 | `historyService.ts`(v6)、`HistoryDetailScreen.tsx`、`HistoryScreen.tsx`、`TrashScreen.tsx`、i18n | 设为封面→库里写入；再点→清空回默认；默认（第一张）自动点亮 |
| 锁竖屏 | `AndroidManifest.xml`、`ios/.../Info.plist` | 强制 `user_rotation=1` 后截图仍是 1200×2608，`overrideOrientation=SCREEN_ORIENTATION_PORTRAIT` |
| 顶栏图标风格统一 | `HistoryDetailScreen.tsx` | 收藏 `⭐/☆`、标记删除 🚫/↩️、重新获取 🔄、删除 🗑 同为 18px |

## 3. 当前状态

- **能不能跑**：能。手机上是 **release 1.0.18**（`npm run apk:local` 覆盖安装，数据保留）。
- **数据**：库 `tgdownloader.sqlite` 889 行（列表 876 + 回收站 13），schema 6，封面全为空。
- **未提交**：`AGENTS.md`、`HANDOVER.md`、`README.md`、`android/app/build.gradle`、
  `android/app/src/main/AndroidManifest.xml`、`ios/TgImagesDownloader/Info.plist`、
  `src/i18n/{zh-CN,en}.ts`、`src/screens/{HistoryScreen,HistoryDetailScreen,TrashScreen}.tsx`、
  `src/services/{historyService,imageDownloader}.ts`、`android/.../TelegraphDownloaderModule.kt`、指令日志。
- **测试残留**：无（测试设过的 3 个封面已用 App 功能清掉；系统收藏也已切回未收藏）。

## 4. 关键决策

- **详情页 pager 常挂所有页**：`{近邻 ? <RecordPage/> : null}` 这种在横向 ScrollView 里动态增删子节点，
  Fabric 会抛 `addViewAt` / `removeViewAt` 两类崩溃。现在改成始终挂载、用 `active` 控制是否渲染图片网格，
  内存仍只保留当前页 ±1 的图。
- **失败图片直接不渲染**：不做占位、不做红叉；`visibleUris` 过滤掉失败项，`oi` 保留在 `uris` 里的原下标，
  拖动排序换算仍正确。
- **不做「单张补下」**：实测老记录的 `imageUrls[i]` 与图片并不可靠对应（例：id=660 的 index 5 指向站点 logo，
  且返回 502），补下会往相册塞错图。故只提示、不提供入口；相关代码已删除。
- **分页固定 50 条**：不再滚动追加，页码区间与「上一页/下一页」永远对得上；页数多时用输入框直达。
- **封面语义**：`cover_uri` 为空 = 用第一张（默认）；全屏按钮三态：默认第一张→提示 / 已自定义→取消 / 其他→设为封面。
- **锁竖屏**：Android `screenOrientation="portrait"` + iOS 仅 Portrait。

## 5. 已知坑

- **Fabric 挂载竞态**：详情页 pager / 网格都不要动态增删子节点，也不要 `numColumns`、不要
  `removeClippedSubviews`（三条都实测崩过）。
- **横向 ScrollView 占位子 View 只给 width 会塌成 0 高** → 白页；必须 `width + height:'100%'`。
- **`contentOffset` 在 Android 不保证生效** → 用 ref `scrollTo` 兜底。
- **慢速拖动只触发 `onScrollEndDrag`** → 分页回调两个都要挂。
- **老记录的 URL/图片对不齐**（`imagePaths` 与 `savePaths` 长度都可能不同）→ 任何「按 URL 补图」的功能都不可靠。
- **gh 上传无进度**，取消会留下 `state=starter` 的空壳附件（占名字但网页不显示）→ 见 AGENTS §14。
- **无线调试灭屏即断**；`adb md5`/mdns 不可用；输入法弹出时底部 tab 点击无效（先收键盘）。
- **screenrecord 抓不到闪烁瞬间**，验证列表稳定性要用「截图 + PIL 逐帧比对，且排除状态栏」。

## 6. 下一步

1. [ ] 发版 v1.0.18（tag 必须在 commit 之后打；附件用 `curl --progress-bar` 传，见 AGENTS §14）
2. [ ] 可选：修 `src/utils/htmlEntities.ts` 的二次编码（`&amp;#8211;` 仍会残留在标题里）
3. [ ] 可选：老记录 URL 错位的存量修复（需要重新解析那一篇，不能靠 index 猜）
4. [ ] 决定 `开发相关资源/page.html` 去留

## 7. 常用命令

```powershell
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'
npm start                                      # Metro（独立可见窗口）
npx react-native run-android --no-packager     # 调试：装 debug，保留数据
npm run apk:local                              # 日常：装 release，保留数据
npx tsc --noEmit; npx jest; npx eslint src/
adb shell uiautomator dump /sdcard/ui.xml      # 真机取证（截图可能被 FLAG_SECURE 拦）
```

## 8. 环境与外部依赖

- 设备 `2509FPN0BC` / Android 16；adb 走 Wi-Fi（`192.168.31.172`，端口会变）。
- 包名**只有一个**：`com.acstd.tgimagesdownloader.release`（debug 也是它，共用一个安装位）。
  **禁止 uninstall**：一卸载数据全没。
- 签名 `MYAPP_RELEASE_*` 在 `android/gradle.properties`（gitignore），keystore 是
  `android/app/TgImagesDownloader.keystore`（相对 app 模块目录）。
- 数据库备份：`backup/db-before-v6-*.sqlite`（迁移前）、`backup/db-before-cover-cleanup-*.sqlite`。
