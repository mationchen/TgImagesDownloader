package com.acstd.tgimagesdownloader.notifier

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Foreground service that keeps the app's process alive while a batch download
 * runs in JS (spec §20). Because the RN JS thread keeps executing as long as
 * the process is alive, starting this service when a batch begins lets the
 * download continue after the user backgrounds the app.
 *
 * The notification is driven from JS through [DownloadNotifierModule]:
 *   - start(...)      -> startForegroundService + running notification
 *   - update(...)     -> refresh progress in the running notification
 *   - finish(...)     -> replace with a completion notification
 *   - stop()          -> stopSelf() and clear the notification
 *
 * Android 13+ needs POST_NOTIFICATIONS (requested from JS); Android 14+ needs
 * the FOREGROUND_SERVICE_DATA_SYNC permission declared in the manifest.
 *
 * While the service is foreground it also holds a PARTIAL_WAKE_LOCK so the CPU
 * (and therefore the RN JS download queue) keeps running after the screen
 * turns off; without it a backgrounded batch stalls as soon as the device
 * suspends.
 *
 * On top of that, aggressive OEM power managers (MIUI/HyperOS, EMUI, ColorOS)
 * freeze a backgrounded app's JS/v8 thread even while a foreground service and
 * wake lock are held — the process stays alive, the notification stays put,
 * but the JS timer that drives the download queue stops firing until the app
 * returns to the foreground. To defeat that, this service emits a periodic
 * "tick" over [DeviceEventManagerModule.RCTDeviceEventEmitter]; delivering a
 * native event wakes the JS thread and lets the queue keep draining.
 */
class DownloadForegroundService : Service() {

  private var wakeLock: PowerManager.WakeLock? = null

  /**
   * High-performance Wi-Fi lock. A PARTIAL_WAKE_LOCK keeps the CPU awake but
   * does nothing for the Wi-Fi radio: with the screen off (or the app
   * backgrounded) the chip drops into power-save mode and throughput can fall
   * by an order of magnitude, which showed up as background downloads taking
   * ~30s for an image that took ~1.8s in the foreground.
   */
  private var wifiLock: WifiManager.WifiLock? = null

  private fun acquireWifiLock() {
    if (wifiLock?.isHeld == true) return
    try {
      val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      wifiLock =
          wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WAKE_LOCK_TAG).apply {
            setReferenceCounted(false)
            acquire()
          }
    } catch (_: Throwable) {
      // Some devices/ROMs refuse the lock; downloads still work, just slower.
    }
  }

  private fun releaseWifiLock() {
    try {
      wifiLock?.let { if (it.isHeld) it.release() }
    } catch (_: Throwable) {
      // ignore
    }
    wifiLock = null
  }

  /** Emits the keep-alive tick to JS so a frozen JS thread gets woken up. */
  private val jsTick = object : Runnable {
    override fun run() {
      emitTick()
      handler.postDelayed(this, TICK_INTERVAL_MS)
    }
  }

  private val handler = Handler(Looper.getMainLooper())

  private fun emitTick() {
    val reactContext = DownloadNotifierModule.reactContextRef ?: return
    try {
      if (!reactContext.hasActiveReactInstance()) return
      reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_JS_TICK, null)
    } catch (_: Throwable) {
      // Best-effort: the JS side is gone or shutting down.
    }
  }

  private fun startJsTicks() {
    handler.removeCallbacks(jsTick)
    handler.postDelayed(jsTick, TICK_INTERVAL_MS)
  }

  private fun stopJsTicks() {
    handler.removeCallbacks(jsTick)
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
        .apply {
          setReferenceCounted(false)
          acquire()
        }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  companion object {
    const val CHANNEL_ID = "downloads"
    const val NOTIFICATION_ID = 1001
    const val WAKE_LOCK_TAG = "TgImagesDownloader:DownloadForegroundService"

    /** Native->JS keep-alive event; see the class KDoc. */
    const val EVENT_JS_TICK = "TgDownloader:keepAlive"
    const val TICK_INTERVAL_MS = 2000L

    /** Live instance so [DownloadNotifierModule] can update notifications. */
    @Volatile
    var active: DownloadForegroundService? = null
      private set

    @Volatile
    private var startedTitle: String = ""
    @Volatile
    private var startedTotal: Int = 0

    fun start(context: Context, title: String, total: Int) {
      startedTitle = title
      startedTotal = total
      val intent = Intent(context, DownloadForegroundService::class.java)
      intent.action = ACTION_START
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, DownloadForegroundService::class.java)
      intent.action = ACTION_STOP
      context.startService(intent)
    }

    const val ACTION_START = "com.acstd.tgimagesdownloader.notifier.START"
    const val ACTION_STOP = "com.acstd.tgimagesdownloader.notifier.STOP"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        active = this
        ensureChannel()
        val notification = buildProgressNotification(
            startedTitle,
            0,
            startedTotal,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          // Android 14+: specify the foreground service type.
          startForeground(
              NOTIFICATION_ID,
              notification,
              ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
          )
        } else {
          startForeground(NOTIFICATION_ID, notification)
        }
        acquireWakeLock()
        acquireWifiLock()
        startJsTicks()
      }
      ACTION_STOP -> {
        stopJsTicks()
        releaseWifiLock()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        active = null
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopJsTicks()
    releaseWifiLock()
    releaseWakeLock()
    if (active === this) {
      active = null
    }
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)
      val channel = NotificationChannel(
          CHANNEL_ID,
          "Downloads",
          NotificationManager.IMPORTANCE_LOW,
      )
      channel.description = "Telegraph download progress"
      nm.createNotificationChannel(channel)
    }
  }

  private fun buildProgressNotification(
      title: String,
      done: Int,
      total: Int,
  ): Notification {
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openIntent?.let {
      PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val progress = if (total > 0) done * 100 / total else 0

    return NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(title.ifBlank { "Telegraph Downloader" })
        // total <= 0 means "parsing between articles": show an indeterminate
        // bar without a misleading "0 / 0" counter.
        .setContentText(if (total > 0) "$done / $total" else null)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setProgress(total, done, total <= 0)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentIntent)
        .build()
  }

  private fun buildCompletionNotification(
      success: Int,
      failed: Int,
      skipped: Int,
  ): Notification {
    val text =
        when {
          failed > 0 -> "$success done, $failed failed, $skipped skipped"
          else -> "$success image(s) saved"
        }
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = openIntent?.let {
      PendingIntent.getActivity(
          this,
          0,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("Telegraph Downloader")
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setAutoCancel(true)
        .setContentIntent(contentIntent)
        .build()
  }

  /** Called by [DownloadNotifierModule] to refresh the running progress. */
  fun updateProgress(done: Int, total: Int) {
    val nm = getSystemService(NotificationManager::class.java)
    nm.notify(
        NOTIFICATION_ID,
        buildProgressNotification(startedTitle, done, total),
    )
  }

  /** Called by [DownloadNotifierModule] to show the completion summary. */
  fun showCompletion(success: Int, failed: Int, skipped: Int) {
    val nm = getSystemService(NotificationManager::class.java)
    nm.notify(NOTIFICATION_ID, buildCompletionNotification(success, failed, skipped))
  }
}