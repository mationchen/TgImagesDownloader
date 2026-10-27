# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 网页图片批量下载 + 下载记录管理 + 压缩包导入 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-10-27 01:56`（本地时区） / 会话：收尾 1.0.15 + 工具链维护 |
| 分支 / 工作区 | `master` / **有 1 个未提交改动**（`开发相关资源/历史迭代指令汇总.md`，+16 行） |
| 当前版本 | `1.0.15（versionCode 15）`，已发布 **v1.0.15（Latest，2026-10-26 16:37Z）** |
| 数据库 schema | v5（迁移在 `src/services/historyService.ts`） |
| 运行环境 | Node 22.23.2；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16（API 36）；**当前 adb 未连接** |

## 1. 这一轮的目标

收尾 1.0.15 的验证与发布，并把「换会话怎么不丢上下文」制度化（全局规则 + 模板 + 命令）；
顺带排查 OpenCode 变慢的原因。

## 2. 已完成（上次提交 `7c99bf4` 之后）

| 改动 | 涉及文件 | 怎么验证的 / 结果 |
|---|---|---|
| 全局新增「会话交接」硬规则 | `C:\Users\Administrator\.config\opencode\AGENTS.md` §十二 | 读回文件确认小节存在（264 → 308 行），备份 `AGENTS.md.20261027_012812.bak` |
| 通用交接模板 | `C:\Users\Administrator\.config\opencode\templates\HANDOVER.md` | 写入后 `Test-Path` = True，71 行 |
| 两个全局命令 `/handover`、`/resume` | `~\.config\opencode\commands\{handover,resume}.md` | `opencode api get /api/command` 返回列表里已含 handover / resume ✅ |
| npm 全局 CLI 从 V1 换到 V2 | 全局 npm | `opencode --version` → `opencode v2.1.4`；`opencode service status` → `http://127.0.0.1:28894` ✅ |
| OpenCode 变慢原因定位 | — | 仅诊断，未改数据：会话 5,990 条 / 124 MB（其中 80.5 MB 是截图）、DB 4.05 GB（2.05 GB 空闲页）、WAL 187 MB、`opencode-cli` 1.15 GB |
| 补齐 10-27 指令日志 | `开发相关资源/历史迭代指令汇总.md` | 追加 7 条，`git diff` 显示 +16 行（未提交） |

### 2.1 更早的成果（已提交，只用 `git log` 概括）

| 提交 | 内容 |
|---|---|
| `7c99bf4` 1.0.15 | 翻页刷新/返回不跳回第一页；一级页面双击返回退出；修复黑夜模式收藏星标不可见；URL 列表新增清除 |
| `50d8448` 1.0.14 | 大图新增「加入系统收藏夹」♥；图片网格标记已收藏的图 |
| `3c8a234` 1.0.13 | 大图查看器改按窗口挂载，修 50+ 张黑屏卡顿；AGENTS 新增「版本号只在提交前升」 |
| `3ad1719` | AGENTS 第一原则：禁止自动 `add/commit/push` |
| `6661c47` 1.0.12 | 收藏 / 标记删除 / 回收站（恢复 + 一键清空）；DB v5 迁移 |

## 3. 当前状态

- **能不能跑**：能。手机上已装 1.0.15（release，覆盖安装，数据保留）。
- **卡点**：无。
- **未提交**：`开发相关资源/历史迭代指令汇总.md`（今日 7 条指令）。源码与文档均已提交。
- **测试是否污染数据**：没有。测试时切换过系统主题（深色 → 已还原「跟随系统」）、切换过一条记录的 ★ 收藏（已还原）；临时文件 `/sdcard/Download/urls_test.txt` 已删除。

## 4. 关键决策（为什么这么做）

- **翻页刷新保持当前页**：`refreshCurrentPage()` 用 `offsetRef` 读当前 offset，且 `reload()` 改成「先 `countHistory` 再取数」，越界时回落到最后一页。
  - 放弃「刷新回第 1 页」，因为用户翻到第 2 页看详情回来会被甩回顶部，体验很差。
  - 代价：每次刷新多一次 `COUNT(*)`（实测 <10 ms）。
- **双击返回只在 Tab 页生效**：`BackHandler` 监听挂在 `MainTabs` 的 `useFocusEffect` 里，栈上有详情页时自动卸载。
  - 放弃在 App 根统一拦截，因为会干扰二级页面正常返回。
- **星标颜色用主题变量**：`headerActionText: { color: c.headerTitle }`，而不是写死白色。
  - 代价：emoji 按钮不受影响（emoji 自带颜色），只有 ☆/★ 这类文字符号受益。
- **系统收藏优先直改 `IS_FAVORITE`**：本 App 自己写入的媒体可直接 `ContentResolver.update`，无弹窗；失败才回退 `MediaStore.createFavoriteRequest`。
  - 代价：回退路径会弹系统确认框，且此时 JS 侧只能乐观显示。
- **大图查看器 ±2 页窗口 + 首图先出**：打开只挂当前一张，`onLoadEnd` 后再放开窗口。
  - 放弃「全部一次加载」，201 张同时解码会黑屏数秒（实测内存只 +25 MB，旧实现会爆）。
- **版本号只在提交前升一次**（AGENTS §13）：日常构建沿用当前版本号。
  - 代价：本地构建的版本号可能与已发布版本同号；**严禁降版本号**（会 `INSTALL_FAILED_VERSION_DOWNGRADE`）。

## 5. 已知坑（现象 → 原因 → 绕法）

- **`gradle` 卡在 `Downloading gradle-9.4.1-bin.zip failed`** → OpenCode 的 shell 读不到机器级 `GRADLE_USER_HOME`，回落到 C 盘残留目录 → 构建前显式设置：`$env:GRADLE_USER_HOME='D:\Android\.gradle'`（`npm run apk:local` 内部也会调 gradle）。
- **Metro 在独立窗口里会自己退出**（多次观察）→ 调试改用 release 包（`npm run apk:local`，JS 已打包，不依赖 Metro）。
- **Kotlin 报 `Unresolved reference 'currentActivity'`** → 该类里属性语法不可用 → 显式调用 `getCurrentActivity()`。
- **RN 0.87 访问 `InteractionManager` 会打 deprecation** → 用 `setTimeout`/`requestAnimationFrame` 延后即可。
- **手机截图黑屏不一定是崩溃** → 小米安全键盘 / 部分页面置 `FLAG_SECURE` → 改用 `uiautomator dump` 读文本与 bounds（不受影响）。
- **`adb install -r` 报 `INSTALL_FAILED_USER_RESTRICTED`** → 多半是息屏/锁屏 → 唤醒解锁后重试。
- **标题仍可能出现 `&amp;#8211;`** → `src/utils/htmlEntities.ts` 的 `decodeHtmlEntities` 只解一次（第 72 行，单次 `replace`）→ 二次编码的标题解不干净，见「下一步」。
- **PowerShell 输出中文乱码** → 控制台是 936 代码页 → 写 UTF-8 文件再用 read 工具看，或 `[Console]::Out.WriteLine()`。
- **`adb screencap` 提示 `Multiple displays were found`** → 无害，可加 `-d` 指定 display 消除。

## 6. 下一步（可执行）

1. [ ] **修二次编码标题**：把 `D:\Android\TgImagesDownloader\src\utils\htmlEntities.ts` 的 `decodeHtmlEntities` 改成「最多循环 3 次直到结果不再变化」，并在 `__tests__/htmlEntities.test.ts` 补一条 `&amp;#8211;` 用例；验证：`npx jest __tests__/htmlEntities.test.ts`。
2. [ ] **决定 `开发相关资源/page.html` 去留**：它是图片链接提取器的临时产物、已被 git 跟踪（`git ls-files` 可见）。要么删除并加进 `.gitignore`，要么明确保留 —— 需你拍板。
3. [ ] **提交本轮唯一未提交文件**：`开发相关资源/历史迭代指令汇总.md`（下次提交一起带上即可）。
4. [ ] **（可选）回收数据库空间**：停 OpenCode 服务后 `sqlite3 E:\OpenCodeCache\opencode\opencode.db "VACUUM;"`，可回收约 2 GB；先备份 `opencode.db`。
5. [ ] **（可选）重新连接手机**：当前 `adb devices` 为空，做真机验证前先插线或 `adb connect 192.168.31.242:36677`。

## 7. 常用命令（照抄即跑）

```powershell
# 构建 + 覆盖安装（release，保留数据）
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'
npm run apk:local

# 校验
npx tsc --noEmit
npx eslint src/
npx jest

# Metro（长时进程，独立窗口启动，端口 8081）
npm start

# 真机取证
adb devices
adb shell uiautomator dump /sdcard/ui.xml; adb pull /sdcard/ui.xml .
adb shell dumpsys meminfo com.acstd.tgimagesdownloader.release
```

## 8. 环境与外部依赖

- 设备：`2509FPN0BC` / Android 16（API 36）；adb 曾通过 Wi-Fi `192.168.31.242:36677` 连接，**当前未连接**。
- 端口：Metro `8081`（用前先确认空闲）；OpenCode 服务 `127.0.0.1:28894`。
- 目录：备份 `backup/`（已 gitignore）；缓存 `E:\OpenCodeCache`（npm / pip / temp / OpenCode DB）。
- 签名：`MYAPP_RELEASE_*` 在 `android/gradle.properties`（gitignore，**勿提交**）。
- 凭据：发版需要已登录的 `gh`（GitHub）与 git 代理配置；**本文件不记录任何密钥**。
- 包名：debug `com.acstd.tgimagesdownloader` / release `com.acstd.tgimagesdownloader.release`（**禁止 uninstall release**，会丢用户数据）。

## 9. 相关链接

- 指令日志：`D:\Android\TgImagesDownloader\开发相关资源\历史迭代指令汇总.md`
- 项目规范：`D:\Android\TgImagesDownloader\AGENTS.md`、`README.md`
- 交接规范：`C:\Users\Administrator\.config\opencode\AGENTS.md` §十二
- 交接模板：`C:\Users\Administrator\.config\opencode\templates\HANDOVER.md`
