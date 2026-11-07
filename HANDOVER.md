# 会话交接单（HANDOVER）

## 基本信息

- 更新时间：2026-11-07 22:29（本地时区）；分支 `master`。
- 仓库：`D:\Android\TgImagesDownloader`。
- 提交准备阶段已升为 `1.0.23 / versionCode 23`，数据库 schema **v12**；尚未提交、打 tag 或发布。
- 上次提交 `d0e395b`；历史上下文中 `v1.0.22` 已发布，不能复用该 tag 覆盖发版。
- Android 16 / 2509FPN0BC；Node 22.23.2，RN 0.87.1；JDK 17。

## 本轮目标

底部 URL 列表改名“批量下载”，详情页支持整本多选移入独立图片回收站，设置页提供预览与清空。

## 已完成与验证

- Tab 中英文改名；详情页增加独立 `ImageSelectionModal`，全选 / 全不选 / 反选作用于整本，包含加载失败的图片，不包含视频；不与长按拖动排序争抢手势。
- 最新调整：去掉详情页独立文字按钮行，改为顶栏 `☑` 图标，与收藏、标记删除、重新解析、删除图标同一行。请求按记录 ID 定向，以 nonce 防止取消后重复打开。
- 详情标题最新改为 16 号字体，向左平移 8dp，单行自适应缩小且不显示省略号；仅影响详情页，位于 `D:\Android\TgImagesDownloader\src\navigation\AppNavigator.tsx`。TypeScript、该文件 ESLint、release 构建通过，最新 APK 已覆盖安装；真机无障碍树显示完整“下载记录详情”，五个操作图标仍同一行。构建日志 `E:\OpenCodeCache\windows-temp\opencode\detail-title-build.log`。
- 全屏预览新增单张图片回收站 `🗑` 图标，顺序为相册收藏 → 封面 → 回收站 → App 收藏；复用本地化确认文案及 `moveImagesToTrash`，捕获确认时 URI，防止重复操作；成功后关闭预览并刷新宫格，不删除相册文件。真机确认四按钮同一行、点击弹出单张移入确认、取消后仍在预览；未实际移动或删除用户图片。最新 TypeScript、28 套 / 267 条测试和 release 构建通过，详情页 ESLint 0 错误 / 3 条既有警告，APK 已覆盖安装。日志 `E:\OpenCodeCache\windows-temp\opencode\viewer-trash-{tests,build}.log`。
- 按提交前升版约定，备份 `D:\Android\TgImagesDownloader\android\app\build.gradle` 后升至 23 / 1.0.23，同步 README 与 AGENTS。`npm run apk:local` 成功，正式包覆盖安装保留数据，`dumpsys package` 确认为 23 / 1.0.23。构建显式禁用 Gradle 常驻 daemon。日志 `E:\OpenCodeCache\windows-temp\opencode\release-1.0.23-build.log`。
- schema v12 增加 `image_trash`：移入仅软隐藏，历史原始数组、相册文件、收藏保留；跨记录引用同一 URI 都隐藏。恢复回原位置；原记录已彻底删除时拒绝恢复并保留回收站条目。
- 读取历史时统一投影过滤回收 URI，全部隐藏后不回退到源图重新显示。图片源地址通过下载台账的 URI 映射，不能将可能错位的数组按下标配对。
- 设置增加图片回收站与计数；支持宫格、全屏缩放、快/慢滑动翻页、恢复和确认清空。清空逐项确认原生删除成功或已不存在，失败保留，清台账只按准确 URI。
- 恢复与清空共用串行锁，旧确认快照不删除已恢复图片。永久删除保留 URI 墓碑，避免旧历史重新显示已删文件；新下载产生的新 URI 不受影响。
- 升级前通过 SQLite `VACUUM INTO` 自动生成 `.before-v12.<时间戳>.bak` 一致性快照；失败停止迁移。真实 SQLite 测试覆盖旧版升级、失败回滚、备份内容、恢复、共享 URI、排序和永久清理。
- `npx jest --runInBand --silent`：**28 套 / 267 条通过**；`npx tsc --noEmit` 通过；ESLint 0 错误、5 条既有警告。
- `D:\Android\TgImagesDownloader\android\gradlew.bat --no-daemon assembleRelease` 构建成功，arm64 APK `adb install -r` 最终覆盖安装成功，手机版本核对为 1.0.22。
- 真机只读交互：Tab 新文案、下载记录详情选择入口、整本 61 张全选与取消、设置图片回收站入口、0 张空态。**未移动/删除用户的任何既有图片**；有数据回收站的预览、恢复、清空用组件测试与真实内存 SQLite 测试覆盖，未宣称实际删除过真机文件。
- 最新图标版重新通过 28 套 / 267 条测试、TypeScript 检查、详情页 ESLint（0 错误、3 条既有警告）和 release 构建，已覆盖安装。真机无障碍树确认五个操作图标均在 y=168..288，同一行；点击 `☑` 打开当前 61 张图集，取消返回详情且未自动重开。未执行图片移动或删除。

## 当前状态

- 有未提交代码与文档，主体功能已实现、出包并安装；没有启动 Metro 或其他常驻服务。
- 旧 everia 修复完整保留：`D:\Android\TgImagesDownloader\src\services\telegraphParser.ts` 与 `D:\Android\TgImagesDownloader\__tests__\everiaListingPage.test.ts`，并非本轮新增需求；未撤销也未提交。
- 新增测试位于 `D:\Android\TgImagesDownloader\__tests__\image{Selection,TrashDatabase,TrashScreen,TrashService}.test.*`。
- 代码修改前的备份在 `D:\Android\TgImagesDownloader\backup`，已被 gitignore；指令日志已追加原始需求及提交准备要求。交流电休眠已恢复 60 分钟、显示器关闭 30 分钟。
- 代理 127.0.0.1:7897 测试可达，提交前 `git ls-remote origin master` 成功，远端为 `d0e395b`。远端无 `v1.0.23` tag，最近 10 个 release 中无同名 release / draft。用户已明确选择“帮我提交（add + commit + push）”，授权本次提交推送；最终提交号与远端结果以 git log / ls-remote 为准，尚未授权代发 release。

## 关键决策与已知坑

- 图片回收站与下载记录回收站完全独立，**移入不释放空间，清空才会影响系统相册文件**。不触碰系统收藏标志。
- 不凭 native 返回“调用成功”就删元数据：`deleteImageForTrash` 必须确认文件删除或确实不存在。iOS 没有此原生删除能力，本地条目会保留并报告未清理，不假成功；iOS 未实机构建验证。
- 全屏图片需满宽 `flex:1,width:'100%'` 容器；慢速翻页同时处理 `onScrollEndDrag`，避免页码和恢复目标错位。
- 历史成功/失败计数仍代表原始下载，不因回收图片重写；排序只重排可见槽，隐藏槽保留供恢复。
- 墓碑长期保留少量 URI 元数据，不在图片回收站计数中出现。旧库快照在 App 私有数据库旁，不能用 `run-as` 读取正式不可调试包；恢复须停 App 后从快照恢复数据库并使用升级前版本，不操作运行中的库。
- 原有保存顺序闸门仍有 30 秒安全阀，超时可放弃严格顺序；本轮未修改。

## 下一步

1. 如用户要实际验证清空，用专门生成的测试媒体和测试记录验证，**不要拿用户已有图集永久删除**。
2. 如用户反馈 everia 仍无法解析，先区分首页缩略图解析与在线图集文章列表抓取；保留现有两个回归用例。
3. 本日已为提交升至 1.0.23，不再重复升版。用户选择“帮我提交”才执行 add / commit / push；否则仅保留命令。tag 必须指向本次新提交后才能发布；不能直接将当前旧 HEAD 打 tag。

## 1.0.23 产物（尚未上传）

目录：`D:\Android\TgImagesDownloader\android\app\build\outputs\apk\release`。

| 文件 | 字节数 | SHA256 |
|---|---:|---|
| app-arm64-v8a-release.apk | 29522530 | E83223DC753733D3935478D11FAC62892C30AD3564429A78F0E27065E86B54CB |
| app-armeabi-v7a-release.apk | 24066640 | 78005B50C6EF05082F2962E57F239C5FE18EE0C793F8F751C9FA91DBFC413DE2 |
| app-x86_64-release.apk | 30174637 | 24034FE4ED3D61A37D9F516D72F662C38EC757B96093E2772D8EB2378E867CC1 |

## 常用命令

```powershell
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location D:\Android\TgImagesDownloader
npx jest --runInBand --silent
npx tsc --noEmit
npx eslint src __tests__
$env:GRADLE_USER_HOME = 'D:\Android\.gradle'
Set-Location D:\Android\TgImagesDownloader\android
.\gradlew.bat --no-daemon assembleRelease
adb install -r D:\Android\TgImagesDownloader\android\app\build\outputs\apk\release\app-arm64-v8a-release.apk
```

- 当前 adb 连接：`192.168.31.172:33901`（无线端口可能变），包名 `com.acstd.tgimagesdownloader.release`；禁止 uninstall。
- 测试 / 构建日志：`E:\OpenCodeCache\windows-temp\opencode\image-trash-{tests,build,lint}.log`。
- 最新图标调整日志：`E:\OpenCodeCache\windows-temp\opencode\image-select-icon-{tests,build,lint}.log`。
- 文档：`D:\Android\TgImagesDownloader\README.md`、`D:\Android\TgImagesDownloader\AGENTS.md`。
