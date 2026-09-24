package com.acstd.tgimagesdownloader.appinfo

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/**
 * Exposes static app metadata (name / version / build) read from the Android
 * PackageManager, plus the active network transport.
 *
 * Mirrored on iOS by `AppInfo.m` (NSBundle) so the 关于 section can show the
 * real store version on both platforms.
 *
 * Methods:
 *   - getAppInfo(): Promise<{ appName, packageName, version, buildNumber }>
 *   - getNetworkType(): Promise<'wifi'|'cellular'|'ethernet'|'none'|'unknown'>
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

  /**
   * Report the transport carrying the user's internet traffic.
   *
   * Scans every connected network rather than just the active one because the
   * active network is the VPN interface when a proxy app (Clash etc.) is
   * running — its capabilities say TRANSPORT_VPN, not WIFI, which would
   * otherwise make a Wi-Fi connection look like "other". The underlying Wi-Fi
   * network is still listed, so it wins here.
   *
   * Resolves 'unknown' on any failure so the JS side never blocks a download
   * on this check.
   */
  @ReactMethod
  fun getNetworkType(promise: Promise) {
    try {
      val cm =
          reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
              as ConnectivityManager
      var wifi = false
      var ethernet = false
      var cellular = false
      for (network in cm.allNetworks) {
        val caps = cm.getNetworkCapabilities(network) ?: continue
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
        when {
          caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> wifi = true
          caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> ethernet = true
          caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> cellular = true
        }
      }
      val type =
          when {
            wifi -> "wifi"
            ethernet -> "ethernet"
            cellular -> "cellular"
            else -> "none"
          }
      promise.resolve(type)
    } catch (_: Throwable) {
      promise.resolve("unknown")
    }
  }

  companion object {
    const val NAME = "AppInfo"
  }
}