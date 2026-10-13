# AGENTS.md

Project-specific guidance for OpenCode agents working in this repo.

## 全局规则（必须遵守）

下面这些规则适用于本次及之后的所有会话，优先级高于其余章节。

### 1. 回复语言

对用户的所有回复（结论、说明、提问、报错分析等）必须使用中文。
代码、注释、文件内容、命令本身保持原文不变。

### 2. 修改前自动备份

每次修改任何程序文件之前，必须先将原文件备份到仓库根目录下的 `backup/`
文件夹（若不存在则自行创建）。

- 备份文件名格式：`原文件名.后辍名.yyyyMMdd_HHmmss.bak`
- 示例：`App.tsx` 在 `2026-09-01_14-32-05` 被备份为
  `backup/App.tsx.tsx.20260901_143205.bak`（按"文件名.后辍名"两段拼接，
  后辍名指文件扩展名，如 `.tsx`、`.json`、`.gradle`）。
- 一次修改多个文件时，逐个备份；同一分钟内多次备份同一文件可以追加毫秒或
  秒级后缀避免覆盖。
- `AGENTS.md` 自身和 `开发相关资源/` 下的文件不属于"程序"，不需要备份。
- `backup/` 加入 `.gitignore`（不要把备份提交进仓库）。

### 3. React Native 规范与跨平台兼容

- 项目使用 React Native 开发，所有修改必须符合 RN 规范（组件、Hook、
  StyleSheet、Platform 模块、TurboModule / Fabric 兼容等）。
- 任何改动都要兼顾 **Android 和 iOS** 两端：涉及平台差异时优先使用
  `Platform.select`、`.android.tsx` / `.ios.tsx` 分文件，或封装到平台无关
  的模块中；不要写"只在某一端能跑"的逻辑而不加注释。
- 涉及原生能力（权限、文件系统、网络、相机等）时，确认所选 RN 库在
  Android、iOS 上都有官方支持；不要假设 Web 端的 API 可用。
- UI / 交互细节要考虑 RN 特性：FlatList/SectionList 替代 .map() 渲染大列表、
  Hermes 引擎已启用（`hermesEnabled=true`，不要写依赖 JSC 行为的代码）、
  New Architecture 已开启（`newArchEnabled=true`，避免使用即将移除的
  旧 API）。

### 4. SQLite 数据库设计（多版本升级兼容）

App 本地数据库必须按"未来会多次升级"的假设来设计：

- 记录每个已发布版本的 `version`（用户当前数据库 schema 版本号），用一个
  元数据表（如 `user_version` / `schema_version`）持久化。
- 写迁移脚本时按版本号顺序累加：v1→v2、v2→v3、v3→v4……每一段迁移只
  处理"上一版本 → 当前版本"的差异。不要写"一步到位"的迁移。
- 用户可能从任意旧版本（如 v1、v3、v7）升级上来，启动时检测当前
  `schema_version`，按顺序连续跑所有未执行的迁移，直到最新版本。
- 迁移要做事务包裹（`BEGIN ... COMMIT`），失败时回滚，避免半成品
  schema 落地。
- 新增表 / 新增列都要考虑旧用户能"平滑过渡"：能用默认值兜底就加默认值，
  不要 `NOT NULL` 又不提供 `DEFAULT`。
- 删表 / 删列要谨慎：先标记 deprecated，下一两个版本再真正移除，给数据
  备份 / 导出留出窗口。
- 设计阶段就要写一份迁移清单（哪个版本加了什么、改了什么），并在
  AGENTS.md 或专门的迁移文档中持续维护。

### 5. 跨页面一致性

同一个功能 / 对象 / 数据在多个页面展示时，在没有特殊要求的情况下，
必须保持以下一致：

- 文案 / 字段名称 / 单位 / 顺序
- 视觉风格（颜色、字号、图标、间距）
- 交互行为（点击、长按、跳转）

避免在不同页面用不同术语描述同一件事（如"图片 / 图像 / Image"混用），
避免同一数据在不同页面格式或精度不同（如时间戳 vs 本地时间、百分比
小数位不一致）。如确有差异，注明原因。

### 6. 时区

- 一切与时间相关的逻辑（持久化、排序、对比、计算）一律使用 **用户手机
  所在地区的时区**。
- **显示给用户看的时间**必须经过用户本地时区转换后再展示，不要直接展示
  UTC 或服务端时区的时间戳。
- 数据库里建议存 UTC（毫秒或 ISO 8601 字符串），展示前再做时区转换。
- 后端返回的时间字段同样要按用户本地时区显示，不要假设它已经是本地
  时间。

### 7. 命令日志（必须执行）

每次用户给出新指令（直接输入到 opencode 文本框的原始内容）后，必须
追加到 `开发相关资源/历史迭代指令汇总.md`：

- 仅记录用户原始输入；**不**记录 AI 回复、AI 转发给大模型的内部 prompt、
  工具调用结果、读到的文件内容、其他任何中间产物。
- 按 **日期** 分组：每天一个 `## yyyy-MM-dd` 小节，文件内按时间顺序
  自上而下追加。
- 每条指令作为该日期小节下的一个列表项（`- ...`），可在条目前加可选的
  `HH:mm:ss` 时间戳（同一分钟内多条按出现顺序排列即可，不必强制时间戳）。
- 同一天内多次追加，在已有的小节末尾继续添加，不要新建同名小节。
- 不要删除 / 编辑已有的历史条目（仅追加）。

### 8. `开发相关资源/` 目录

`开发相关资源/` 目录（及其下的所有内容）属于"开发相关资源"，与程序
主体无关。**不要去阅读、修改、分析或将其纳入代码逻辑的考量**——
除非本文件第 7 条明确要求向其写入命令日志。

### 9. 国际化 / 本地化（i18n）

App 必须支持多国语言，所有 UI 文案统一走 i18n，禁止在代码里硬编码
用户可见文本。

- **单一 i18n 配置源**：全部可本地化的文案（按钮、标题、占位符、提示、
  错误信息、状态文案等）都从统一的 i18n 配置文件（`src/i18n/`）读取，
  组件 / 页面通过 i18n 提供的函数（如 `t(key)`）取词，不在页面内写死
  中文字符串。
- **默认语言**：简体中文（`zh-CN`）；**已支持**：英文（`en`）。
  新增语言时在 i18n 配置中追加一个字典即可，不改页面调用逻辑。
- **为其他语言留好配置空间**：i18n 配置按"语言键 → 文案字典"结构组织，
  语言集合可在配置中声明（如 `supportedLocales`），新增语言只需：增加
  一份对应语言的字典文件，并把它挂到 i18n 入口的语言配置里；缺词的
  key 降级回退默认语言，不要抛错或显示裸 key。
- 所有时间显示也必须经过本地时区转换（见 §6），与 i18n 无关的纯功能性
  文本（如 URL、命令输出）不受此条约束。
- 涉及平台能力或系统 UI 的文案（如权限弹窗、系统分享），沿用系统 / 组件
  自带本地化，不需自行维护。

### 10. 后台/长时进程必须显式可见且可由用户关闭

当你在后台运行命令行启动的服务器端进程（例如 `dotnet run`、
`dotnet HAO.RIZI.Api.exe`、`npx react-native start` / Metro、
`npx react-native run-android` / `run-ios`、Gradle daemon、
长时间 `npm test --watch` 等），必须**在独立的 PowerShell/终端窗口中启动**，
并在执行后告知用户：

1. 进程名 / 命令 / 端口 / 启动 URL（如 `http://127.0.0.1:5180/swagger`），
   便于用户打开浏览器 / 客户端；
2. 进程 PID（任务管理器 / `Get-NetTCPConnection` 可查），以及如何用
   `Stop-Process -Id <pid> -Force` 或 `taskkill /PID <pid> /F` 关闭；
3. 如果是 dev server（如 `npx react-native start`、`.NET` 监听 5180、
   `ngrok` 等）必须同时提醒它会**持续占用该端口**直到用户主动停止，
   未停止前端口可能不可复用；
4. **禁止**让 opencode 在自己进程内静默持有长期 dev server / 守护进程——
   一旦后端服务在 opencode 内部启动到后台，必须向用户确认后再决定是否
   关闭，且默认不能跨回合继续占用。

### 11. Shell 中文输出编码（避免乱码）

本机 Windows 控制台代码页是 **936（GBK）**，而 opencode 按 **UTF-8** 解码命令输出，
因此把中文直接打到 stdout 会出现乱码（如 `δ��Forewise`）。必须遵守：

1. **Python 一律加 `-X utf8`**（或先设 `$env:PYTHONIOENCODING='utf-8'`）。
2. **PowerShell 输出中文**时：先执行
   `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，并且中文**必须经**
   `| ForEach-Object { [Console]::Out.WriteLine($_) }` 输出 —— 只设编码对
   `Write-Output` / `Write-Host` / 裸字符串**无效**（已实测）。
3. 中文内容较多时，**优先写入 UTF-8 文件，再用 read 工具查看**。
4. **不要**用 `Select-String` / `Get-Content` / Python 默认编码把中文直接打印到 stdout。
5. `git status` 的中文路径被转义成八进制属正常现象，不是乱码。

### 12. 「总结工作 + 提交 git」的标准流程

当用户说**「总结一下今天的工作，我要提交 git」**（或类似措辞：「总结工作要提交 git」
「准备提交 git」「写个提交信息」）时，**立刻照做，不要反问**，按以下步骤执行：

1. **读指令日志**：读取 `开发相关资源/历史迭代指令汇总.md` —— 它按第 7 条记着用户
   每一条原始指令，是「这段时间到底干了什么」最可靠的来源。
2. **用 git 定时间窗口**：`git log -1 --format=%cI` 取上次提交的时间，只汇总
   **该时间之后到现在**的指令与产出；上次提交说明里写过的不要重复。
3. **写 ≤100 字的中文总结**：写「做了什么 + 修了什么 + 版本变化」，
   **总字数控制在一百个字符以内**；沿用本项目格式 `yyyy年M月d日，<摘要>`。
4. **给出可直接复制的提交命令**（`git add -A` → `git commit -m "…"` →
   `git push origin master`）。**不要替用户执行 `git commit`**，除非用户明确说
   「你提交」。注意本机 git 配了 `http.proxy=127.0.0.1:7897`，代理没起时 push 会报
   `Failed to connect to github.com:443 over proxy`，用
   `git -c http.proxy= -c https.proxy= push origin master` 绕过。
5. **涉及发版时补上发布命令**：`git tag vX.Y.Z` + `git push origin vX.Y.Z` +
   `gh release create vX.Y.Z`（附 `app-arm64-v8a-release.apk`、
   `app-armeabi-v7a-release.apk`、`app-x86_64-release.apk` 三个架构）。
6. **同步更新 `README.md`**：总结里提到的功能 / 版本变化，如果 README 有对应描述
   （特性清单、版本号、目录结构、命令），一并改掉，保持文实相符。

> 依据是「指令日志 + git 区间」这两份可核对的事实，**不要凭记忆写摘要**。
> 通用部分（触发语、代理绕过、不替用户提交）另见本机全局 `AGENTS.md` 第八节。


---

## State of the project

A shipped Android app (release **1.0.10**, `versionCode 10`): a web image batch
downloader, plus a download-history manager and a local archive import feature.
`README.md` is this project's own documentation — read it first for features,
commands, layout and the release flow.

Source lives under `src/` (`screens` / `services` / `components` / `store` /
`theme` / `i18n` / `navigation` / `utils` / `types`). Native Kotlin modules sit
in `android/app/src/main/java/com/acstd/tgimagesdownloader/` (`downloader`,
`archive`, `notifier`, `share`, `appinfo`) and are registered in
`MainApplication.kt`. Date-stamped instruction history and other dev material
live in `开发相关资源/` — per rule 8, do not read it, except for the rule 7 log.

Feature areas:

- 批量下载 — parse a page, download its images to the gallery, with a foreground
  service + wake/wifi locks keeping long batches alive in the background.
- 下载记录 — status/date filters, pull-to-refresh, detail grid + fullscreen
  viewer, re-parse, delete (optionally removing the saved files too).
- 解压压缩包 — in-app archive browser (archives only, sort / filter / imported
  badge) importing zip / 7z / tar / rar (incl. RAR5), de-duplicated by content
  fingerprint; videos go to the video gallery and open in the system player.

## Stack (pinned, recent — do not "update" to older defaults)

- `react-native` 0.87.1, `react` 19.2.3
- `typescript` ^6.0.3 (TS 6 is brand new; expect occasional tool friction)
- `node` >= 22.11.0 (enforced via `engines` in package.json)
- Hermes + New Architecture are enabled (`android/gradle.properties`):
  `newArchEnabled=true`, `hermesEnabled=true`, `edgeToEdgeEnabled=true`
- Android namespace / applicationId: `com.tgimagesdownloader`
- iOS entry is Swift (`ios/TgImagesDownloader/AppDelegate.swift`) and ships
  `PrivacyInfo.xcprivacy` (required by Apple — don't delete).

The only non-template runtime dependency is `react-native-safe-area-context`
^5.5.2 — it's already wired up in `App.tsx`. Prefer it over the deprecated
`SafeAreaView` from `react-native`.

## Commands (npm)

The only npm scripts are the stock set:

- `npm start` — Metro bundler
- `npm run android` — build & launch on Android (needs Metro running, or it
  will start it)
- `npm run ios` — build & launch on iOS (needs Metro running)
- `npm run lint` — ESLint via `@react-native` config (`.eslintrc.js`)
- `npm test` — Jest via `@react-native/jest-preset`

iOS first-build setup that is easy to forget:

```sh
bundle install                # one-time, to get CocoaPods
bundle exec pod install       # every time native deps change
```

Android first-build: nothing extra — `android/gradlew` is checked in.

## Things that look like scripts but aren't

There is no `npm run typecheck` and no `npm run format` script, even though
TypeScript and Prettier are both installed. Use:

- `npx tsc --noEmit` for a typecheck (tsconfig extends
  `@react-native/typescript-config`, includes `**/*.ts`/`**/*.tsx`, excludes
  `node_modules` and `Pods`)
- `npx prettier --write .` to format (config in `.prettierrc.js`:
  `singleQuote: true`, `trailingComma: 'all'`, `arrowParens: 'avoid'`)

There is no CI workflow. Don't waste time looking for `.github/` or a pre-commit
hook — they don't exist.

## Testing

- Jest is configured (`jest.config.js` → `@react-native/jest-preset`).
- Only one test exists today: `__tests__/App.test.tsx` — a `react-test-renderer`
  render check. This project uses **react-test-renderer**, not
  `@testing-library/react-native` — don't add RTL imports without also adding
  the dep.
- No fixtures, no integration tests, no snapshot baseline committed yet.

## Android gotchas

- `android/app/build.gradle` currently uses `signingConfigs.debug` for **release**
  builds. That's a template default and is **not** safe to ship — generate a
  real keystore before any production release
  (https://reactnative.dev/docs/signed-apk-android).
- `enableProguardInReleaseBuilds = false` by default.
- Architectures built: `armeabi-v7a,arm64-v8a,x86,x86_64`. Trim with
  `./gradlew <task> -PreactNativeArchitectures=arm64-v8a` for faster local
  builds.
- `compileSdk 37`, `targetSdk 36`, `minSdk 24`, `ndk 27.1.12297006`,
  `kotlin 2.2.0`, `buildTools 37.0.0`.

## Conventions observed

- Source layout is flat at the repo root (`App.tsx`, `index.js`). There is no
  `src/` convention established yet — introduce one deliberately if you split
  `App.tsx` up.
- Functional components only; no class components in template.
- Imports: RN first, then third-party, then local — matches the template.
- All generated / state directories are gitignored (`node_modules`, `Pods`,
  `android/build`, `android/.gradle`, `.bundle/*` is partly ignored, etc.).
  `android/app/debug.keystore` is intentionally committed (debug only).
- `backup/`（按第 2 条规则创建）也应当被 gitignore，不要提交进仓库。

## Out of scope for this file

Do not duplicate the upstream React Native getting-started guide — it's in
`README.md` already and is the authoritative source for Metro / emulator
setup, dev-menu shortcuts, etc.