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

---

## State of the project

This is a fresh React Native template — `App.tsx` still renders the stock
`<NewAppScreen />` from `@react-native/new-app-screen`. There is no app code,
no `src/` directory, and no feature logic. Any real work starts by replacing
`App.tsx` (or introducing a `src/` layout). There is no existing
domain code to extend or follow as a pattern.

No prior agent / cursor / copilot / claude instruction files exist. README.md
is the upstream RN bootstrap README and should not be treated as project docs.

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