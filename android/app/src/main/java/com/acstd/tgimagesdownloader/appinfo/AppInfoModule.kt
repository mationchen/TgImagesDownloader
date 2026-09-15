package com.acstd.tgimagesdownloader.appinfo

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/**
 * Exposes static app metadata (name / version / build) read from the Android
 * PackageManager.
 *
 * Mirrored on iOS by `AppInfo.m` (NSBundle) so the 关于 section can show the
 * real store version on both platforms.
 *
 * Methods:
 *   - getAppInfo(): Promise<{ appName, packageName, version, buildNumber }>
 */
class AppInfoModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getAppInfo(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val pm = ctx.packageManager
      val packageName = ctx.packageName
      val info = pm.getPackageInfo(packageName, 0)

      val map: WritableMap = Arguments.createMap()
      map.putString(
          "appName",
          info.applicationInfo?.let { pm.getApplicationLabel(it).toString() } ?: "",
      )
      map.putString("packageName", packageName)
      map.putString("version", info.versionName ?: "")
      // longVersionCode (API 28+) avoids the deprecated versionCode; fall back
      // to the int field on older devices.
      val buildNumber =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode.toString()
          } else {
            @Suppress("DEPRECATION") info.versionCode.toString()
          }
      map.putString("buildNumber", buildNumber)
      promise.resolve(map)
    } catch (t: Throwable) {
      promise.reject("ERR_APP_INFO", t.message, t)
    }
  }

  companion object {
    const val NAME = "AppInfo"
  }
}
