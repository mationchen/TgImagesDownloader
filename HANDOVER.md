# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-11-02 23:45`（本地时区） / 会话：在线图集、图集标签、预览图与筛选修复 |
| 分支 / 工作区 | `master` / 本轮改动未提交（见 §3） |
| 当前版本 | `1.0.19（versionCode 19）`，已构建并覆盖安装，**待发版** |
| 数据库 schema | **v7**（`tags` / `tags_checked_at`，迁移在 `src/services/historyService.ts`） |
| 运行环境 | Node 22；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16 |

## 1. 这一轮的目标

在「URL 列表」里加在线图集抓取，给下载记录加图集标签，并修掉收藏筛选不生效、补上预览图的大图查看。

## 2. 已完成（上次提交 `1fe0a22` 之后）

| 改动 | 涉及文件 | 怎么验证的 / 结果 |
|---|---|---|
| **在线图集**：从 everia.club 第 1–10 页（默认 1–5）抓「文章 + 一张预览图」，按 URL 去重、剔除已下载，勾选后并入待下载 | `services/everiaListing.ts`、`BatchListScreen.tsx`、`types/batch.ts`、i18n | 真机 5 页抓到 150 条 / 已下载 27 / 候选 123；加入队列后行内带缩略图与标题 |
| 抓取必须**顺序**：并发 5 页会全部超时 | `everiaListing.ts` | 单页 1–3 秒，5 页并发全超时（实测） |
| **标签**（schema v7）：详情页显示标签；新下载解析时自动带；设置页可对老记录按原网址补全 | `services/tags.ts`、`tagBackfill.ts`、`components/TagBackfillModal.tsx`、`historyService.ts`、`telegraphParser.ts`、`HistoryDetailScreen.tsx`、`SettingsScreen.tsx` | 迁移前后 903 行不变；详情页显示 `标签 Bimilstory / Seoyool 서율`；存量补齐 536 条 |
| 修 **收藏筛选点了不生效**：切换筛选的 effect 依赖里漏了 `filterFavorite` | `HistoryScreen.tsx` | 点 ★ → `第 1-17 条 / 共 17 条`，再点恢复 903 |
| 在线图集**预览图可点开大图**、**左右滑动看相邻候选**、**直接选中/取消选中** | `BatchListScreen.tsx`、i18n | 1/123 → 左滑 2/123（标题同步）→ 取消选中 → 关闭后「已选 122 条」，该行复选框变空心 |

## 3. 当前状态

- **能不能跑**：能。手机上是 **release 1.0.19**（`npm run apk:local` 覆盖安装，数据保留）。
- **数据**：903 条记录（含 73 条本地压缩包）；**536 条已有标签**，292 条待补（约 290 条是 `www.1y.is` 整站 502，其余是 everia 的 TLS 偶发失败）。
- **未提交**：`AGENTS.md`、`README.md`、`android/app/build.gradle`、`src/i18n/{zh-CN,en}.ts`、`src/screens/{BatchListScreen,HistoryScreen,HistoryDetailScreen,SettingsScreen}.tsx`、`src/services/{historyService,telegraphParser,tags,tagBackfill,everiaListing}.ts`、`src/types/{batch,telegraph}.ts`、`src/components/TagBackfillModal.tsx`、`__tests__/{tags,everiaListing}.test.ts`、指令日志。
- **测试污染**：无（没有真正下载任何图片；在线图集的测试队列已通过界面清空）。

## 4. 关键决策

- **标签存 JSON 列**（`tags` + `tags_checked_at`）而不是关联表：列表渲染不用 join，代价是以后做「标签云/按标签统计」要自己聚合。
- **无标签也要记 `tags_checked_at`**：否则每次补全会把几百条本来没标签的页面重抓一遍。
- **标签只读**：不做手动编辑，避免「自动补全 vs 手工修改」的冲突；重解析时新标签覆盖旧的，空数组不覆盖。
- **补全走顺序 + 自适应间隔（1.2–8 秒）+ 主机熔断（连续失败 5 次）**：并发会被限流，1y.is 整站 502 时不该把 308 条各试 3 次。
- **820 条存量在电脑上补**：同一份 `extractTags` 编译成 JS 跑 curl（手机 OkHttp 对 everia 会偶发挂死），再写回数据库副本并用 `run-as cp` 推回，推之前先备份。
- **在线图集预览用横向 paging ScrollView** 而不是 Reanimated pager：与详情页现有查看器一致，`onMomentumScrollEnd` + `onScrollEndDrag` 都挂，慢拖也能翻页。

## 5. 已知坑

- **电脑直连 everia 被墙**：Node 的 `fetch` 不认 `HTTP(S)_PROXY`，要 `curl --proxy http://127.0.0.1:7897`（1–2 秒/页）。
- **手机 OkHttp 对 everia 偶发挂死**：同一 URL 手机 curl 0.9 秒、RN fetch 25 秒超时；`Connection: close`、换 blob-util 都没根治。
- **`www.1y.is` 当前整站 502**（主页也 502），308 条记录的标签补不了，等站点恢复。
- **everia 老文章会 404**（跳回首页），所以存量补不全属正常。
- **切换筛选的 effect 必须带上对应 state**：漏 `filterFavorite` 时界面亮灯但列表不重查。
- **静态站（`*.github.io`）的标签写在标题里**：`#年年 - 沐浴 #漏点 #巨乳 [50P]`，离线解析，不用联网。
- **`tuzac.com` 的 meta keywords 混着 SEO 堆词**（美女/性感/高清…），只在没有真实标签时兜底并过黑名单。
- **无线调试灭屏即断**；锁屏后 `uiautomator dump` 会 dump 出 0 个节点，**这不是 App 崩溃**。
- **预览大图里点图片=关闭，滑动=翻页**：靠 ScrollView 接管手势区分，别把 onPress 挂到图片本身。

## 6. 下一步

1. [ ] 发布 v1.0.19（tag 必须在 commit 之后打；附件用 `curl --progress-bar` 逐个传，见 AGENTS §14）
2. [ ] `www.1y.is` 恢复后，继续补那 292 条（设置 → 标签 → 补全标签，或再跑一次电脑端脚本）
3. [ ] 可选：修 `src/utils/htmlEntities.ts` 的二次编码（`&amp;#8211;` 仍会残留）
4. [ ] 可选：老记录 URL 与图片错位的存量修复（需重新解析那一篇，不能按 index 猜）

## 7. 常用命令

```powershell
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'
npm start                                      # Metro（独立可见窗口）
npx react-native run-android --no-packager     # 调试：装 debug，保留数据
npm run apk:local                              # 日常：装 release，保留数据
npx tsc --noEmit; npx jest; npx eslint src/
adb shell uiautomator dump /sdcard/ui.xml      # 真机取证（锁屏时会 dump 出空节点）
```

## 8. 环境与外部依赖

- 设备 `2509FPN0BC` / Android 16；adb 走 Wi-Fi（`192.168.31.172`，端口会变；`adb connect <ip>:<port>` 重连）。
- 包名只有一个：`com.acstd.tgimagesdownloader.release`（debug 也是它），**禁止 uninstall**。
- 签名 `MYAPP_RELEASE_*` 在 `android/gradle.properties`（gitignore）。
- 数据库备份：`backup/db-before-v6-*.sqlite`、`backup/db-before-v7-20261102_194925.sqlite`。
- 电脑端补标签的一次性脚本（不入库）：`E:\OpenCodeCache\windows-temp\opencode\tagjs\`（`fetch-tags.cjs` + `urls.json` + `results.ndjson`）、合并脚本 `E:\OpenCodeCache\windows-temp\opencode\merge_tags.py`。
