package com.acstd.tgimagesdownloader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.acstd.tgimagesdownloader.share.ShareIntentModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.ReactApplication

class MainActivity : ReactActivity() {

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
  }
}
