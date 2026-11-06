# 会话交接单（HANDOVER）

> 新会话开场：`/resume`（或先读本文件 → `git log -5` → `git status`）。

## 0. 基本信息

| 项 | 内容 |
|---|---|
| 项目 | 网页图片批量下载器（TgImagesDownloader）—— 批量下载 + 下载记录管理 + 压缩包导入 + 在线图集/漫画 |
| 仓库路径 | `D:\Android\TgImagesDownloader` |
| 最后更新 | `2026-11-06 22:20`（本地时区） / 会话：缺页检查 / 成功数 / 相册顺序 |
| 分支 / 工作区 | `master` / **有未提交改动**（见 §3） |
| 当前版本 | `1.0.22（versionCode 22）`，APK 已出（未装到手机，见 §3） |
| 数据库 schema | **v11**（v10: `image_favorites` + `title_plain`；v11: `success_count += skipped_count` 校正） |
| 运行环境 | Node 22；RN 0.87.1（Hermes + New Arch）；实测机 2509FPN0BC / Android 16；JDK 17 |

## 1. 这一轮的目标

1. 全屏按钮顺序改为「相册收藏 → 封面 → App 收藏」；2. 标题复制加 0.5s 提示；
3. 在线图集「上次未入选 / 曾下载后删除」默认不选中，预览也显示标记；
4. 分页完整性检查（含批量行内提示、漫画不误报）；5. 成功数计入跳过；
6. 并发下载时保证系统相册顺序。

## 2. 已完成（带验证）

| 改动 | 验证 |
|---|---|
| 全屏顶栏顺序：相册收藏 → 封面 → App 收藏 | 真机：页码 285-426，按钮从 567 起，无重叠 |
| 标题点击复制后屏幕底部弹「标题已复制」0.5 秒 | 真机截图捕获 |
| 在线图集标记项默认不勾选；全屏预览标题下显示徽章 | 真机：150 条 / 45 新 / 默认已选 35；带「🗑 曾下载后删除」的行无 ✓，预览显示徽章 |
| 分页完整性：单页失败不再中断、补抓一次；`expectedImageCount(perPage, pages)`；批量行内橙色「⚠ 可能缺页」 | 单测 2 条（漫画 366 张无提示、普通图集缺 1 页 → 41–60）；真机预览曾显示「177–192 实际 151」 |
| 漫画不再套「每页 N 张」：adapter 新增 `wholeGalleryFromFirstPage`，解析器不翻页；另加 perPage>200 闸门 | 单测：366 张、仅 1 个请求、无缺页提示 |
| 成功数 = 新保存 + 已存在跳过（写库 + v11 迁移校正旧数据） | 真机：49 项记录 成功 0→49；再跑一次全跳过仍 49/0；部分失败记录 165/166、74/81 |
| **相册顺序**：新增 `saveOrderGate`，下载仍 8 并发，入库按页码 N→1 串行；30s 安全阀；取消/失败都会放行 | 真机下 81 张图集：`_id ASC` = 0081→0001，`_id DESC` = 0001→0081，81/81 成功 |
| 校验 | `npx tsc --noEmit`；`npx jest` 23 套 / **242** 条；`npx eslint src __tests__` 0 error |

## 3. 当前状态

- APK 已构建（arm64 29482806 B / armeabi-v7a 24026916 B / x86_64 30134913 B），但**本次安装时 adb 设备掉线**
  （`adb devices` 空、mDNS 无设备），手机上仍是 1.0.21；重新 `adb connect 192.168.31.172:<端口>` 后
  `adb install -r android\app\build\outputs\apk\release\app-arm64-v8a-release.apk` 即可。
- 未提交：见 `git status`（17 改 + 3 新增：`saveOrderGate.ts`、`parseCompleteness.test.ts`、`saveOrderGate.test.ts`）。
- 测试留下的数据：在线图集多了一场抓取快照（150 条 / 45 新，仅选了 1 条并下载）；下载了一篇
  《攝影師 luka 模特 Dora》81 张（`_174603`），`image_favorites` 少 1 张（早些验证时移除）。

## 4. 关键决策

- **并发下载 + 串行入库**：不牺牲下载速度，只把「写 MediaStore」这一步按页码倒序排队，
  `date_added` 只有秒级精度时靠 `_id` 也能保证第 1 页最前。
- **完整性检查只在「有网络类失败且张数不足」时提示**；404 分页链接、漫画都不提示，避免狼来了。
- **成功口径**：跳过（文件已存在）与成功等价 —— 用户看到的是「这张图在不在」。

## 5. 已知坑

- 相册排序依赖 `date_added DESC`（秒级）+ `_id` 兜底；若某相册 App 只按秒级 `date_added` 且不兜底，同秒内的顺序可能仍不稳定。
- `saveOrderGate` 若某页长时间重试会堵住更小页码的入库，30s 后自动放行（日志 `save gate timeout`）。
- hanime `comic` 站偶发 `403`/解析失败（PC 走代理同样 403），与代码无关，等站点/节点恢复。
- 无线调试灭屏即断，`adb devices` 空时先 `adb connect`。

## 6. 下一步

1. [ ] 手机重连后安装 1.0.22 并做一次普通图集的新下载，肉眼确认相册顺序
2. [ ] 提交 + 发版（tag 在 commit 之后打，APK 用 `curl --progress-bar` 逐个上传）
3. [ ] 老账：`www.1y.is` 恢复后补完剩余 292 条标签

## 7. 常用命令

```powershell
cd D:\Android\TgImagesDownloader
$env:GRADLE_USER_HOME='D:\Android\.gradle'

cd android; .\gradlew.bat assembleRelease; cd ..
adb install -r android\app\build\outputs\apk\release\app-arm64-v8a-release.apk

npx tsc --noEmit; npx jest; npx eslint src __tests__

# 核对相册入库顺序
adb shell "content query --uri content://media/external/images/media --projection _id:_display_name --sort '_id DESC'"
```

## 8. 环境与外部依赖

- 设备：`2509FPN0BC` / Android 16，adb 走 Wi-Fi（`192.168.31.172:<端口>`，端口会变）；包名
  `com.acstd.tgimagesdownloader.release`，**禁止 uninstall**。
- PC 访问 `everia.club` 需代理 `127.0.0.1:7897`；`hanimeone.me` 目前 PC 侧 403。
- 签名在 `android/gradle.properties`（gitignore）；GitHub 用本机 `gh`，不要把 token 写进文件。

## 9. 相关链接

- 项目文档：`D:\Android\TgImagesDownloader\README.md`
- 开发约定：`D:\Android\TgImagesDownloader\AGENTS.md`
- 指令日志：`D:\Android\TgImagesDownloader\开发相关资源\历史迭代指令汇总.md`
