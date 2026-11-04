# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 + 在线图集/漫画 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-11-04 23:35`（本地时区） / 会话：标签 / App 内收藏 / 搜索修复 |
| 分支 / 工作区 | `master` / **有未提交改动**（见 §3） |
| 当前版本 | `1.0.21（versionCode 21）`，已出包；待提交 + 发版 |
| 数据库 schema | **v10**（新增 `image_favorites` 表、`history.title_plain`；历史见 `historyService.ts` 的 MIGRATIONS） |
| 运行环境 | Node 22；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16；JDK 17 |

## 1. 这一轮的目标

1. 标签可点（复制 / 按标签筛选）；2. 全局「收藏图片」页；3. App 内收藏（不再写系统相册收藏）；
4. 修标题搜索（搜不到、清空不恢复、加搜索按钮）；5. 详情页标题与标签可复制；
6. 布局：移入回收站改图标并挪进筛选行；7. 修收藏页全屏黑屏、页码与收藏按钮重叠；8. 状态筛选加「待删除」。

## 2. 已完成（带验证方式）

| 改动 | 验证 |
|---|---|
| 标签点击 → `复制标签 / 查看该标签的下载记录 / 取消`；选第二项跳回下载记录并按标签筛选（顶部 chip「标签：xxx」） | 真机：选「Kanna Seto 瀬戸環奈」→ 34 条 |
| 标题点击复制；标签复制 | 复制后用输入法粘贴到搜索框，内容一致 |
| 搜索：合并成一个去抖 effect（清空也会重查）、新增 🔍 按钮与键盘搜索键、结果滚回顶部、请求序号防旧结果覆盖、SQL 补 `ESCAPE`、按解码标题（`title_plain`）匹配 | 真机：`bomb` → 24 条；清空 → 恢复 1026 条；粘贴完整中日文标题 → 精确 1 条 |
| App 内收藏：详情全屏「♥ 收藏」胶囊（与「相册收藏」并存）、宫格 ♥ 角标改读 `image_favorites` | 真机：点收藏变红、关掉后格子出现「已收藏（App 内）」 |
| 「收藏图片」页：筛选栏 ♥ 进入，宫格 3:4 + 全屏翻页 + 取消收藏 + 查看所属记录；首次打开把本 App 目录下的系统收藏一次性导入（原生 `listFavoriteImages`） | 真机：导入后 178 张（旧系统收藏 + 新收藏）；取消收藏 178→177 |
| 回收站按钮挪到筛选行末尾，图标 + 角标条数 | 真机：16 角标；少占一行 |
| 修收藏页全屏黑屏：页容器 `alignItems:'center'` 把 `ZoomableImage` 宽度压成 0，补 `viewerPageInner`（`flex:1` + `width:'100%'`） | 真机：图片正常显示 |
| 修页码重叠：`viewerCounterWrap` 由绝对定位改为 `flex:1` 参与布局 | 真机顶栏：`× | 2 / 49 | ♡收藏 相册收藏 封面` 不重叠 |
| 状态筛选新增「🗑 待删除」（`mark_deleted = 1`，不含回收站）；顺带修 `buildFilter` 漏判 `markedDeletedOnly` 导致筛选不生效 | 真机：16 条，与角标一致 |
| 校验 | `npx tsc --noEmit` 通过；`npx jest` 21 套 / 233 条通过；`npx eslint src __tests__` 0 error |

**数据订正**：验证「取消收藏」时移除了 1 张旧的系统收藏导入项（仅 App 收藏，未动系统相册标记），当前收藏 176 张。

## 3. 当前状态

- 能跑：手机上是 release **1.0.21**（`npm run apk:local` 覆盖安装，数据保留）。
- 未提交：本轮 + 上一轮（漫画站）的改动，见 `git status --short`；版本号已升 1.0.21，`README.md` 已同步。
- 卡点：无。
- 已知遗留：`www.1y.is` 恢复后补完剩余 292 条标签。

## 4. 关键决策

- **App 收藏与系统收藏彻底分开**：用户反馈系统相册收藏被塞满；App 收藏只写本机 `image_favorites`，
  系统收藏保留原按钮不动。旧系统收藏一次性导入（settings 标记 `image_favorites_imported_v1`），避免升级后空列表。
- **标签筛选复用下载记录列表**（带参数 `Tabs → History { tag }` + 顶部 chip），不再新开一个页面。
- **搜索兜底做足**：清空重查、去抖 + 显式按钮、请求序号、`ESCAPE`、解码标题列 —— 用户反馈的三类症状
  （搜不到 / 清空不恢复 / 无按钮）一次覆盖。

## 5. 已知坑

- **全屏查看器黑屏**：`ZoomableImage` 必须放在满宽容器里；父级 `alignItems:'center'` 会让它宽度塌成 0
  （图已加载但画不出来）。
- **顶栏页码**：不要用 `position:'absolute'` 居中，右侧按钮一多就叠字；用 `flex:1`。
- **`buildFilter` 的「是否有筛选」判断**：新增筛选条件必须同步加进那个 return 条件，否则筛选条出现但列表不查。
- 真机 UI 坐标：`uiautomator dump` 的 bounds 是物理像素（本机 1200×2608），截图也是 1200×2608。
- 其他历史坑（漫画顺序、gzip、锁屏、无线调试）见前一份交接单 / `AGENTS.md`。

## 6. 下一步（可执行）

1. [ ] 提交本轮并升版发版：按 AGENTS 第 12/14 条（tag 在 commit 之后打，APK 用 `curl --progress-bar` 逐个上传）
2. [ ] 需要时把验证时移除的那张收藏补回（收藏页无「撤销」，只能在对应记录里重新点收藏）
3. [ ] 复核收藏页在图片很多（几百张）时的滑动与内存
4. [ ] 老账：`www.1y.is` 恢复后补完剩 292 条标签

## 7. 常用命令（照抄即可）

```powershell
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'

# 构建 + 覆盖安装（保留数据）
npm run apk:local

# 校验
npx tsc --noEmit; npx jest; npx eslint src __tests__

# 调试（需 Metro，独立窗口）
npm start
npx react-native run-android --no-packager

# 真机取证
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml E:\OpenCodeCache\windows-temp\opencode\ui.xml
```

## 8. 环境与外部依赖

- 设备：`2509FPN0BC` / Android 16，adb 走 Wi-Fi（`192.168.31.172:<端口>`，端口会变）；包名唯一：
  `com.acstd.tgimagesdownloader.release`，**禁止 uninstall**。
- PC 访问 `hanimeone.me` / `everia.club` 需代理：`curl --proxy http://127.0.0.1:7897`。
- 目录：构建产物 `android\app\build\outputs\apk\release\`；数据库备份 `backup\db-before-v*-*.sqlite`；
  临时脚本 `E:\OpenCodeCache\windows-temp\opencode\`。
- 凭据：签名在 `android/gradle.properties`（已 gitignore）；GitHub 用本机 `gh`，**不要**把 token 写进文件。

## 9. 相关链接（可选）

- 项目文档：`D:\Android\TgImagesDownloader\README.md`
- 开发约定：`D:\Android\TgImagesDownloader\AGENTS.md`
- 指令日志：`D:\Android\TgImagesDownloader\开发相关资源\历史迭代指令汇总.md`
