package com.acstd.tgimagesdownloader.notifier

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
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
 *   - isIgnoringBatteryOptimizations(): whether the app is whitelisted from
 *     Doze/battery optimization (needed for long background batches)
 *   - requestIgnoreBatteryOptimizations(): open the system whitelist dialog
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

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    try {
      val pm = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      promise.resolve(pm.isIgnoringBatteryOptimizations(appContext.packageName))
    } catch (_: Exception) {
      // Fail open: assume whitelisted so callers never nag by accident.
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:" + appContext.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      appContext.startActivity(intent)
      promise.resolve(null)
    } catch (_: Exception) {
      // Some vendors remove the per-app dialog; fall back to the whitelist
      // list screen so the user can still add the app manually.
      try {
        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        appContext.startActivity(intent)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("ERR_BATTERY", e.message ?: "cannot open battery settings", e)
      }
    }
  }

  companion object {
    const val NAME = "TelegraphNotifier"
  }
}