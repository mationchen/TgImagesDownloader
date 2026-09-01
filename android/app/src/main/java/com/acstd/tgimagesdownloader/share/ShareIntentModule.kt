package com.acstd.tgimagesdownloader.share

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Exposes shared text/plain intents (e.g. "Share -> Telegraph Downloader")
 * to JS. RN's built-in `Linking` only handles ACTION_VIEW / URL schemes, not
 * ACTION_SEND with text/plain, so we bridge it ourselves (spec §7 / §33 Phase 7).
 *
 * Events:
 *   - "TelegraphShare" -> { url: string | null, hasUrl: boolean }
 *
 * Methods:
 *   - getInitialShare(): Promise<{url|null}>  (cold start)
 *   - setPendingShare(map) / consumePendingShare()  (warm start bridge)
 */
class ShareIntentModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  /** Buffered URL captured between the time an onNewIntent fired and the JS
   *  side subscribed. Avoids losing a share that arrives before listeners
   *  are mounted. */
  private var pendingShareUrl: String? = null

  init {
    active = this
  }

  override fun getName(): String = NAME

  /** Reads a URL that was shared into the app on a cold start. */
  @ReactMethod
  fun getInitialShare(promise: Promise) {
    val url = extractUrlFromIntent(reactApplicationContext.currentActivity?.intent)
    val map: WritableMap = Arguments.createMap()
    map.putString("url", url)
    map.putBoolean("hasUrl", url != null)
    promise.resolve(map)
  }

  @ReactMethod
  fun consumePendingShare(promise: Promise) {
    val url = pendingShareUrl
    pendingShareUrl = null
    val map: WritableMap = Arguments.createMap()
    map.putString("url", url)
    map.putBoolean("hasUrl", url != null)
    promise.resolve(map)
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required for NativeEventEmitter to work.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required for NativeEventEmitter to work.
  }

  /**
   * Called from MainActivity.onNewIntent to hand a freshly-shared URL to JS.
   */
  fun handleNewShareIntent(intent: Intent) {
    val url = extractUrlFromIntent(intent)
    if (url != null) {
      // Always buffer so a consumer that polls later still sees it.
      pendingShareUrl = url
    }
    emitShare(url)
  }

  private fun emitShare(url: String?) {
    val map: WritableMap = Arguments.createMap()
    map.putString("url", url)
    map.putBoolean("hasUrl", url != null)
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("TelegraphShare", map)
  }

  companion object {
    const val NAME = "TelegraphShare"

    /** Latest module instance so MainActivity can forward onNewIntent to it. */
    @Volatile
    var active: ShareIntentModule? = null

    private const val MIME_PLAIN_TEXT = "text/plain"

    /** Pull the first Telegraph URL (or any http(s) URL) out of a share intent. */
    private fun extractUrlFromIntent(intent: Intent?): String? {
      if (intent == null) return null
      val type = intent.type ?: return null
      val isPlainText = type.startsWith(MIME_PLAIN_TEXT) || type.startsWith("text/*")
      if (!isPlainText) return null

      when (intent.action) {
        Intent.ACTION_SEND -> {
          val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
          return firstUrl(text)
        }
        Intent.ACTION_SEND_MULTIPLE -> {
          val items =
              intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT) ?: return null
          for (item in items) {
            val url = firstUrl(item?.toString())
            if (url != null) return url
          }
          return null
        }
        Intent.ACTION_VIEW -> {
          val data = intent.dataString
          return if (data != null && (data.startsWith("http://") || data.startsWith("https://")))
            data else null
        }
        else -> return null
      }
    }

    private fun firstUrl(text: String?): String? {
      if (text.isNullOrBlank()) return null
      // Look for the first http(s) URL anywhere in the shared text.
      val regex = Regex("https?://[^\\s<>\"'`]+")
      val match = regex.find(text) ?: return null
      return match.value
    }
  }
}
