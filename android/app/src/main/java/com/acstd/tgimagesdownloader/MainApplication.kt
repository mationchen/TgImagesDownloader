package com.acstd.tgimagesdownloader

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.acstd.tgimagesdownloader.appinfo.AppInfoPackage
import com.acstd.tgimagesdownloader.downloader.TelegraphDownloaderPackage
import com.acstd.tgimagesdownloader.notifier.DownloadNotifierPackage
import com.acstd.tgimagesdownloader.share.ShareIntentPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Manually-registered native modules (autolink doesn't pick these up
          // because they live in the app module rather than as a separate
          // npm package).
          add(TelegraphDownloaderPackage())
          add(ShareIntentPackage())
          add(DownloadNotifierPackage())
          add(AppInfoPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
