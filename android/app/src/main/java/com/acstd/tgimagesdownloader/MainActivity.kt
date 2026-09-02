package com.acstd.tgimagesdownloader

import android.app.Activity
import android.content.Intent
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
    }
  }
}
