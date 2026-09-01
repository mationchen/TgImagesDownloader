package com.acstd.tgimagesdownloader.notifier

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS -> native bridge for download notifications (spec §21).
 *
 * Methods:
 *   - start(title, total): begin a foreground download notification
 *   - update(done, total): refresh the running progress
 *   - finish(success, failed, skipped): show a completion notification
 *   - stop(): remove the foreground service + notification
 */
class DownloadNotifierModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val appContext = reactContext.applicationContext

  override fun getName(): String = NAME

  @ReactMethod
  fun start(title: String, total: Int, promise: Promise?) {
    try {
      DownloadForegroundService.start(appContext, title, total)
      promise?.resolve(null)
    } catch (e: Exception) {
      promise?.reject("ERR_START", e.message ?: "failed to start foreground service", e)
    }
  }

  @ReactMethod
  fun update(done: Int, total: Int) {
    // The service instance may not be running yet (race with start()); guard
    // so a null active instance is simply a no-op.
    val service = DownloadForegroundService.active
    if (service != null) {
      service.updateProgress(done, total)
    }
  }

  @ReactMethod
  fun finish(success: Int, failed: Int, skipped: Int) {
    val service = DownloadForegroundService.active
    if (service != null) {
      service.showCompletion(success, failed, skipped)
    }
  }

  @ReactMethod
  fun stop() {
    try {
      DownloadForegroundService.stop(appContext)
    } catch (_: Exception) {
      // Ignore: service may not have been running.
    }
  }

  companion object {
    const val NAME = "TelegraphNotifier"
  }
}