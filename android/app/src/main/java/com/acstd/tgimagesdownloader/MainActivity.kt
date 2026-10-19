package com.acstd.tgimagesdownloader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.acstd.tgimagesdownloader.share.ShareIntentModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.ReactApplication

class MainActivity : ReactActivity() {

  /**
   * 丢弃系统传入的 savedInstanceState。
   *
   * 进程被系统回收后从「最近任务」切回时，系统会用保存的实例状态重建 Activity，
   * 进而尝试恢复 react-native-screens 的 Fragment —— 而 ScreenFragment 明确禁止被
   * 恢复，构造函数直接抛异常，App 闪退：
   *
   *   Fragment$InstantiationException: Unable to instantiate fragment
   *   com.swmansion.rnscreens.ScreenStackFragment
   *   Caused by: IllegalStateException: Screen fragments should never be restored.
   *
   * RN 的界面/导航状态由 JS 侧自己维护（数据在 SQLite / 文件里），不需要系统级恢复，
   * 所以这里传 null 让 Activity 干净地重新开始。参考：
   * https://github.com/software-mansion/react-native-screens/issues/17#issuecomment-424704067
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "TgImagesDownloader"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    ShareIntentModule.active?.handleNewShareIntent(intent)
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == 0x7744 && resultCode == Activity.RESULT_OK && data != null) {
      val uri = data.data ?: return
      try {
        contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
      } catch (_: Throwable) {
      }
      // Try to emit to JS if React context is available
      try {
        val app = application as ReactApplication
        val reactContext = app.reactHost?.currentReactContext as? ReactApplicationContext
        val module = reactContext?.getNativeModule(
            com.acstd.tgimagesdownloader.downloader.TelegraphDownloaderModule::class.java
        )
        module?.handlePickedTreeUri(uri.toString())
      } catch (_: Throwable) {
      }
      return
    }
    if (requestCode == 0x7745) {
      val module = com.acstd.tgimagesdownloader.downloader.TelegraphDownloaderModule.getInstance()
      if (module == null) return
      val promise = module.consumePickTextPromise()
      if (promise == null) return
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        module.resolvePickText(promise, null, null, null)
        return
      }
      val uri: Uri = data.data!!
      try {
        val name = contentResolver
          .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
          ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
          ?: uri.lastPathSegment ?: "urls.txt"
        val content = module.readPickedText(uri)
        module.resolvePickText(promise, uri.toString(), name, content)
      } catch (e: Throwable) {
        try {
          module.resolvePickText(promise, null, null, null)
        } catch (_: Throwable) {
        }
      }
    }
    if (requestCode == 0x7746) {
      val module = com.acstd.tgimagesdownloader.archive.ArchiveModule.getInstance()
      module?.consumePickedTree(if (resultCode == Activity.RESULT_OK) data?.data else null)
      return
    }
    if (requestCode == 0x7747) {
      val module = com.acstd.tgimagesdownloader.archive.ArchiveModule.getInstance()
      module?.consumePickedArchives(if (resultCode == Activity.RESULT_OK) data else null)
      return
    }
  }
}
