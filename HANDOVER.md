# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-10-30 20:40`（本地时区） / 会话：debug 与 release 统一为同一安装（保留 release 数据） |
| 分支 / 工作区 | `master` / 本轮改动未提交（见 §3） |
| 当前版本 | `1.0.17（versionCode 17）`，已构建并覆盖安装，**待发版** |
| 数据库 schema | v5（迁移在 `src/services/historyService.ts`） |
| 运行环境 | Node 22.23.2；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16（API 36） |

## 1. 这一轮的目标

修下载记录分页的错位/闪烁，补回收站容量与预览，并解决详情页左右滑动闪退。

## 2. 已完成（上次提交 `1129bf7` 之后）

| 改动 | 涉及文件 | 怎么验证的 / 结果 |
|---|---|---|
| 分页错位：越界回退按页大小对齐、翻页一次取满 100 条、末页禁用「下一页」 | `utils/pagination.ts`（新）、`HistoryScreen.tsx`、`__tests__/pagination.test.ts`（新） | 真机 889 条：翻页即时 `101-200`；末页 `801-889` 且按钮 disabled；`npx jest` 9 条新用例 |
| 第二页下拉闪烁：翻页前滚回顶部 + `loadMore` 并发闸门 | `HistoryScreen.tsx` | 第二页快速滑到底，页码恒定、无重复 key 警告 |
| 分页边界 Toast（列表） | 同上 | 第一页点「上一页」/末页点「下一页」→ `dumpsys window` 出现 Toast |
| 回收站容量 500：满后拒绝移入 + 顶部说明 + 空态也显示 | `historyService.ts`、`TrashScreen.tsx`、`HistoryScreen.tsx` | 空态/有数据两种状态均显示 `已存 N / 500 条` |
| 回收站缩略图 + 整行进详情 | `TrashScreen.tsx` | 56dp 缩略图节点可见；点击进详情，可左右滑相邻记录 |
| 还原保留删除标记 | `historyService.ts` | 标记 → 移入 → 恢复，列表仍显示「移入回收站（1）」 |
| **详情页滑动闪退**（Fabric `addViewAt`）| `HistoryDetailScreen.tsx` | 第二页 201 项图集起滑，**80 次有效滑动**（每 10 次校验标题变化）无崩溃，内存 290-390 MB 稳定 |
| 详情页边界提示（当前页首/末条） | 同上 | 「完成」后 Toast：`已经是第一条` / `返回列表翻页` 等四种文案 |
| 退出详情后列表回到该条 | `utils/lastViewed.ts`（新）、`HistoryScreen.tsx` | 日志 `target=929 → found at section=3 item=0`，列表命中 |
| 详情页序号徽章 + 路径徽章 + 失败图片改文字提示 | `HistoryDetailScreen.tsx`、`navigation/types.ts`、i18n | 徽章行：`✓ 完成 | 第 1 / 876 条 | Pictures/TelegraphDownloader` |
| 详情页/列表「图片打不开」：文件其实是 WebP 却登记成 image/jpeg | `TelegraphDownloaderModule.kt`（新增 `sniffMimeType()` 按文件头判类型）、`HistoryDetailScreen.tsx`、`HistoryScreen.tsx`、`TrashScreen.tsx` | 拉库文件确认 `RIFF…WEBP` 头；新下载按真实类型入库；全屏 / 详情网格 / 列表 / 回收站共 4 处均改为「本地失败→远程兜底」 |
| debug 与 release 统一为一个安装（同包名 + 同正式签名） | `android/app/build.gradle`、`scripts/build-local.ps1`、`README.md`、`AGENTS.md` | 验签一致（SHA-256 `AD:DF:…:05:06`）；release→debug→release 双向覆盖，889 行数据始终未变；旧 debug 包已卸载（库备份在 `backup/`） |

## 3. 当前状态

- **能不能跑**：能。手机当前装的是 **release 1.0.17**（包名 `com.acstd.tgimagesdownloader.release`），
  已实测列表「共 876 条」。要调试就 `npx react-native run-android --no-packager`（会换成 debug，数据不变）。
  Metro 仍在独立窗口运行（端口 8081），收工可直接关掉那个窗口。
- **未提交**：`HistoryScreen.tsx`、`HistoryDetailScreen.tsx`、`TrashScreen.tsx`、`historyService.ts`、`navigation/types.ts`、`i18n/{zh-CN,en}.ts`、`README.md`、`AGENTS.md`、`android/app/build.gradle`、`scripts/build-local.ps1`、`TelegraphDownloaderModule.kt`、指令日志、`HANDOVER.md`；新增 `utils/pagination.ts`、`utils/lastViewed.ts`、`__tests__/pagination.test.ts`。
- **数据现状**：库 `tgdownloader.sqlite` 共 889 行，回收站 13 条（未清空），无「待删除」标记、无收藏。

## 4. 关键决策

- **详情页 pager 弃用 FlatList**：Fabric 下虚拟化会在滑动时 remove/add cell，抛 `addViewAt: failed to insert view ...`。改成 ScrollView + 固定 N 个占位 View（子节点永不增删），只挂「当前页 ±1」。
- **网格弃用 `numColumns`**：`index=4 count=3` 的越界正来自 numColumns 分组；改成「一行一个 cell、行内固定 3 格」，每行结构恒定。
- **不要加 `removeClippedSubviews`**：同属那条崩溃路径，加了必崩（实测）。
- **回收站移入/还原都不清 `is_marked_deleted`**：用户要求还原后保留删除意图；`countMarkedDeleted()` 已带 `trashed_at = 0`，不会重复计数。
- **序号用全局位置**（offset + 页内 index + 1），与分页条的 `101-200` 对齐；从回收站进的详情不显示序号。
- **debug / release 统一成一个安装（2026-10-30）**：两者都用 applicationId
  `com.acstd.tgimagesdownloader.release` + `signingConfigs.release`，互相覆盖安装保留数据，
  不能再共存。`.release` 后缀是历史包袱（手机数据挂在这个包下），不是为了区分变体。
  参照 iWorkDaily 的同类配置。

## 5. 已知坑

- **别把 debug 的 signingConfig 改回 `signingConfigs.debug`** → 签名一变就无法覆盖安装，
  只能 `adb uninstall`，而卸载会清空 889 条记录的全部数据。
- **debug 首次启动会弹系统「Android 应用兼容性」对话框**（Android 16 对 debuggable 应用
  的 16 KB 页对齐检查；release 不会弹）→ 点「不再显示」即可继续，不是崩溃。
- **Fabric `addViewAt` 闪退** → FlatList 虚拟化 / numColumns / removeClippedSubviews 三处都可能触发 → 详情页已全部绕开，别再改回去。
- **横向 ScrollView 的占位子 View 只给 width 会塌成 0 高** → 整页白屏；必须 `width + height:'100%'`。
- **ScrollView 的 `contentOffset` 在 Android 不保证生效** → 用 ref `scrollTo` 兜底，否则停在空占位页（白页）。
- **慢速拖动只触发 `onScrollEndDrag`**，不触发 `onMomentumScrollEnd` → 分页回调两个都要挂。
- **无线调试灭屏即断**（实测 30 秒 offline、2.5 分钟 TCP 断），端口随之变化；`adb mdns` 在本机不可用（5353 被 svchost/chrome 占），只能手动 `adb connect IP:端口`。
- 其余沿用上一版：`GRADLE_USER_HOME` 需显式指定、`&amp;#8211;` 二次编码未修。

## 6. 下一步

1. [ ] 发版 v1.0.17（tag + release，三个架构 APK；v1.0.16 已于 2026-10-30 00:31 发过）
2. [ ] 修 `src/utils/htmlEntities.ts` 的二次编码（最多解 3 次），补 `&amp;#8211;` 用例
3. [ ] 可选：扫存量图片、按文件头纠正 MediaStore 里的 MIME（老记录断网时仍打不开，现在只靠远程兜底）
4. [ ] 决定 `开发相关资源/page.html` 去留
5. [ ] 可选：回收站详情页也显示序号（按回收站内位置）

## 7. 常用命令

```powershell
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'
npm start                  # Metro（必须在独立可见窗口）
npx react-native run-android --no-packager   # 调试：装 debug，覆盖当前安装、保留数据
npm run apk:local          # 日常：装 release，覆盖 debug、同样保留数据
npx tsc --noEmit; npx jest; npx eslint src/
adb shell uiautomator dump /sdcard/ui.xml   # 真机取证（截图可能被 FLAG_SECURE 拦）
```

## 8. 环境与外部依赖

- 设备 `2509FPN0BC` / Android 16；adb 走 Wi-Fi（`192.168.31.172`，端口会变）。
- 包名**只有一个**：`com.acstd.tgimagesdownloader.release`（debug 也是它）。
  旧的独立 debug 包 `com.acstd.tgimagesdownloader` 已于 2026-10-30 卸载，
  其数据库（7 条记录）备份在 `backup/old-debug-tgdownloader-*.sqlite`。
  **禁止 uninstall**：一卸载数据全没。
- 签名 `MYAPP_RELEASE_*` 在 `android/gradle.properties`（gitignore）。
