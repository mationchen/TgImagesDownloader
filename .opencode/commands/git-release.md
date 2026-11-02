---
description: 给当前版本生成发版命令（tag + release + 带进度条的 APK 上传）；生成后用两个选项问是否代你执行
---

用户要求发版。**立刻按本项目 AGENTS.md §14 执行，不要反问。**

只输出中文；命令、路径、版本号保持原文。

## 1. 前置检查（任一不满足就停下说明，不要硬发）

- `git status --short` 必须为空：有未提交改动 → 提示先跑 `/git-commit`，停
- 版本号：`android/app/build.gradle` 的 `versionName` / `versionCode`
- 远程是否已有同名 tag：`git ls-remote --tags origin`
- 是否已有同名 release / draft 残留：
  `gh api "repos/mationchen/TgImagesDownloader/releases?per_page=10" --jq '.[] | "\(.id) tag=\(.tag_name) draft=\(.draft)"'`
- APK 产物：`android\app\build\outputs\apk\release\*.apk` 是否存在；
  不存在 → 提示先跑 `npm run apk:local`，停
- 网络：`Test-NetConnection 127.0.0.1 -Port 7897` + `git ls-remote origin master`，
  决定 push 要不要加 `-c http.proxy= -c https.proxy=`

## 2. 产出三段命令（严格按 §14，不给「一条 gh 带附件」的写法）

1. **tag**（必须在 commit 之后）：
   `git tag vX.Y.Z` → `git log -1 --format='%h %s' vX.Y.Z` 核验指向 → `git push origin vX.Y.Z`
2. **release**（不带附件，秒完成）：
   用 here-string 把 notes 写到 `E:\OpenCodeCache\windows-temp\opencode\release-notes-X.Y.Z.md`，
   再 `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <该文件>`
3. **上传**：三个 APK 逐个
   `curl.exe --progress-bar -X POST -H "Authorization: Bearer $tok" -H "Content-Type: application/octet-stream" --upload-file <文件> "https://uploads.github.com/repos/mationchen/TgImagesDownloader/releases/$id/assets?name=<文件名>"`
4. **核对**：`gh api "repos/mationchen/TgImagesDownloader/releases/$id/assets" --jq '.[] | "\(.name) \(.size) \(.state) \(.digest)"'`
   要求全部 `uploaded`，字节数与 `digest` 都和本地一致；
   同时给出本地字节数表与 `Get-FileHash -Algorithm SHA256` 作基准
5. 提示：`state=starter` 是取消上传留下的空壳，先
   `gh api -X DELETE "repos/mationchen/TgImagesDownloader/releases/assets/<id>"` 再补传

## 3. 然后必须问（用 question 工具，两个选项，不要用文字问）

问题：`要我现在替你发版吗？`

- **帮我发版（建 tag + release）**
- **先不发（我自己来）**

## 4. 用户选择后的行为

- **帮我发版**：视为明确授权，按顺序执行
  1. `git tag` + 核验指向 + `git push origin vX.Y.Z`
  2. `gh release create`（**不带附件**）
  3. **APK 上传必须在独立可见的 PowerShell 窗口里跑**（80MB 级别，进度必须可见）：
     `Start-Process pwsh -ArgumentList '-NoExit','-Command','<curl 循环命令>'`
     启动后告诉我：窗口在哪、完整命令、三个文件名与大小、怎么停（Ctrl+C 或关窗口）。
     **不要把上传塞进后台任务**——那样我看不到进度，也不该把长时进程挂在会话里
  4. 上传结束后由你核对 assets，并在聊天里报告：文件名 / 字节数 / state / digest 是否与本地一致
- **先不发**：停手，保留命令供我复制，**不建 tag、不建 release、不执行任何 git 写操作**，也不要再追问

## 5. 硬边界

- 不擅自覆盖已存在的 tag / release：发现同名就先说明，让我决定「覆盖（`gh release upload --clobber`）」还是「升版本」
- 不改版本号、不改代码、不 force push
- assets 没核对成功之前，不许说「已发布」
