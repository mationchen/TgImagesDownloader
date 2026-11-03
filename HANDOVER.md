# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-11-03 23:55`（本地时区） / 会话：竖版缩略图、刷新状态、在线图集历史列表 |
| 分支 / 工作区 | `master` / 本轮改动未提交（见 §3） |
| 当前版本 | `1.0.20（versionCode 20）`，已构建并覆盖安装，**待发版** |
| 数据库 schema | **v9**（`tags` / `tags_checked_at` / `deleted_urls` / `listing_sessions` / `listing_session_items`） |
| 运行环境 | Node 22；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16 |

## 1. 这一轮的目标

把列表与详情宫格改成竖版；给批量下载列表加「刷新状态」并整理按钮位置；在线图集支持挑历史抓取记录重开，并标出「上次未入选 / 曾下载后删除」。

## 2. 已完成（上次提交 `81f3d57` 之后）

| 改动 | 涉及文件 | 怎么验证的 / 结果 |
|---|---|---|
| 下载记录**列表缩略图** 56×56 → 56×74（3:4） | `HistoryScreen.tsx` | 真机截图：竖图不再被裁成方形 |
| 详情页**宫格** 正方形 → 3:4，并把拖动排序的坐标改成 `cellW / cellH` | `HistoryDetailScreen.tsx` | 截图确认格子变竖版；拖动逻辑随坐标系一起改 |
| 批量列表新增**刷新状态**：重查 history + 墓碑，标出「已下载 / 以前删除过 / 待下载」 | `BatchListScreen.tsx`、`historyService.ts` | 弹窗「已下载 0 条 · 以前删除过 0 条 · 待下载 2 条」 |
| 「刷新状态」「清除」移到**开始按钮右边**（顶栏只留重新选择/压缩包/在线图集） | 同上 | 截图：`[开始][刷新状态][清除]` 同一行 |
| 在线图集**每次抓取各存一份**（v9 两表），面板可打开**历史列表**挑任意一次重开（不联网，沿用当时勾选） | `historyService.ts`、`BatchListScreen.tsx` | 历史列表显示「1,2,3,4,5 页 · 抓到 150 条 · 已选 2 条」；点开后 34 条、2 条仍勾选 |
| **墓碑表** `deleted_urls`：删除记录 / 清空回收站时留痕；在线图集与批量列表据此提示「曾下载后删除」；重新下载成功自动清除 | `historyService.ts` | 注入测试墓碑后列表出现「🗑 曾下载后删除」，验完已清理 |
| 「上次未入选」提示 | 同上 | 先选 2 条加入，再抓一次 → 未选的显示「上次未入选」 |

## 3. 当前状态

- **能不能跑**：能。手机上是 **release 1.0.20**（`npm run apk:local` 覆盖安装，数据保留）。
- **数据**：1016 条记录；536 条有标签，**292 条仍待补**（`www.1y.is` 整站 502 为主）。
- **未提交**：`AGENTS.md`、`README.md`、`android/app/build.gradle`、`HANDOVER.md`、`src/i18n/{zh-CN,en}.ts`、`src/screens/{BatchListScreen,HistoryScreen,HistoryDetailScreen}.tsx`、`src/services/historyService.ts`、`src/types/batch.ts`、指令日志。
- **测试残留**：无（测试造的墓碑、会话快照、队列都已清理；1016 条记录未动）。

## 4. 关键决策

- **每次抓取独立成 session**（`listing_sessions` + `listing_session_items`），而不是「一个 URL 一行」：否则后一次抓取会覆盖前一次的勾选，历史列表就读不全。
- **v8 的 `listing_items` 只迁移不删除**（AGENTS §4：先弃用再删）。
- **无标签/无删除的提示都要能自证**：`tags_checked_at` 记录"看过没标签"，墓碑只在"彻底删除/清空回收站"时写（移入回收站不算）。
- **刷新状态放在开始旁边**、顶栏只留导入类操作：顶栏原来 5 个按钮会换行/被切。
- **宫格改比例必须同时改拖动坐标系**：`cell` 拆成 `cellW / cellH`，否则命中格错位。

## 5. 已知坑

- **列表/宫格的布局常量**：`COLS=3`、`GAP=2`，`tileSizeFor()` 只算宽度，高度是 `size*4/3`；改比例时三处（tile、占位、拖动 ghost）都要一起改。
- **抽屉式会话表**：`listing_session_items` 的主键是 `(session_id, url)`，写勾选时一定要带 `session_id`，否则会串场。
- **墓碑语义**：只有 `purgeHistory`（删除记录 / 清空回收站）写墓碑；移入回收站不写；重新下载成功会删掉该 URL 的墓碑。
- **无线调试灭屏即断**；锁屏后 `uiautomator dump` 会返回 0 个节点（不是崩溃）。
- **在线图集抓取必须顺序**，并发会被限流（见 `everiaListing.ts`）。
- **everia 在电脑上要代理**（curl `--proxy 127.0.0.1:7897`），Node 的 fetch 不认 `HTTP(S)_PROXY`。

## 6. 下一步

1. [ ] 发布 v1.0.20（tag 在 commit 之后打；附件用 `curl --progress-bar` 逐个传，见 AGENTS §14）
2. [ ] `www.1y.is` 恢复后补完剩余 292 条标签
3. [ ] 可选：`src/utils/htmlEntities.ts` 的二次编码修复（`&amp;#8211;` 残留）
4. [ ] 可选：老记录 URL 与图片错位的存量修复（需重新解析）

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

- 设备 `2509FPN0BC` / Android 16；adb 走 Wi-Fi（`192.168.31.172:<端口>`，端口会变，`adb connect` 重连）。
- 包名只有一个：`com.acstd.tgimagesdownloader.release`（debug 也是它），**禁止 uninstall**。
- 数据库备份：`backup/db-before-v6..v9-*.sqlite`（每次迁移前都留了一份）。
- 电脑端补标签脚本（不入库）：`E:\OpenCodeCache\windows-temp\opencode\tagjs\`、合并脚本 `merge_tags.py`。
