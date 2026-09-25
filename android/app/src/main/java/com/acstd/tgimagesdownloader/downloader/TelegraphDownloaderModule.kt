package com.acstd.tgimagesdownloader.downloader

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.MediaStore.Images
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request

/**
 * Native bridge that copies a local image file into MediaStore so it shows
 * up in the system gallery under Pictures/TelegraphDownloader/<subfolder>/.
 */
class TelegraphDownloaderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  // Main-thread handler used to schedule the text-picker self-healing
  // timeout. Declared before `init` so the init block can reference it.
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  init {
    // Hold a static reference so MainActivity (and any other lifecycle
    // hook) can resolve the module directly without traversing
    // `application as ReactApplication` (which is fragile in bridgeless
    // mode when `reactHost.currentReactContext` may not be ready).
    instance = this
  }

  override fun getName(): String = NAME

  /**
   * Shared OkHttp client for [downloadToCache].
   *
   * Two deliberate choices, both driven by measurement on a real device:
   *
   *  - **HTTP/1.1 only.** These image CDNs serve HTTP/2 badly across a VPN:
   *    with h2 enabled a ~300 KB image took 12-60s (and often hit the 90s
   *    timeout), while the device's own curl — which only speaks HTTP/1.1 —
   *    fetched the same URL in 0.7-2.4s. Forcing HTTP/1.1 restores that.
   *  - **Short-lived connection pool.** A reused-but-dead connection (VPN or
   *    NAT silently dropping idle sockets) hangs until the read timeout, so
   *    idle connections are kept for only 30s instead of OkHttp's 5 minutes.
   */
  private val httpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .protocols(listOf(Protocol.HTTP_1_1))
        .connectionPool(ConnectionPool(8, 30, TimeUnit.SECONDS))
        .build()
  }

  override fun invalidate() {
    super.invalidate()
    // React Native tears the module down on JS reload. Clear any pending
    // state so a re-instantiated module starts clean.
    pendingPickTextTimeout?.let { mainHandler.removeCallbacks(it) }
    pendingPickTextTimeout = null
    pendingPickTextPromise = null
    if (instance === this) instance = null
  }

  @ReactMethod
  fun saveImageToMediaStore(
      localFilePath: String,
      subfolder: String,
      filename: String,
      customTreeUri: String,
      storageType: String,
      promise: Promise,
  ) {
    try {
      val safeSubfolder = sanitizePathSegment(subfolder)
      val safeFilename = sanitizePathSegment(filename)
      if (safeFilename.isEmpty()) {
        promise.reject(ERR_INVALID, "filename is empty or contains only invalid chars")
        return
      }

      val source = File(localFilePath)
      if (!source.exists() || !source.isFile) {
        promise.reject(ERR_NOT_FOUND, "source file not found: $localFilePath")
        return
      }
      if (source.length() <= 0L) {
        promise.reject(ERR_EMPTY, "source file is empty (0 bytes)")
        return
      }

      val mimeType = inferMimeType(safeFilename, source)

      // Compute the correct base path based on storageType so that images
      // land in the directory the JS side expects (Pictures vs Download).
      val basePath = if (storageType == "downloads") BASE_RELATIVE_PATH_DOWNLOAD else BASE_RELATIVE_PATH

      val resultUri: Uri =
          when {
            customTreeUri.isNotEmpty() -> saveToCustomTree(source, safeSubfolder, safeFilename, mimeType, customTreeUri)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> saveOnAndroidQ(source, safeSubfolder, safeFilename, mimeType, basePath)
            else -> saveOnAndroidLegacy(source, safeSubfolder, safeFilename, mimeType, basePath)
          }

      val response = WritableNativeMap()
      response.putString("uri", resultUri.toString())
      response.putDouble("bytes", source.length().toDouble())
      response.putString("mimeType", mimeType)
      response.putString("filename", safeFilename)
      response.putString("subfolder", safeSubfolder)
      response.putBoolean("legacy", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && customTreeUri.isEmpty())
      promise.resolve(response)
    } catch (e: SecurityException) {
      promise.reject(ERR_PERMISSION, e.message ?: "SecurityException", e)
    } catch (e: IOException) {
      promise.reject(ERR_IO, e.message ?: "IOException", e)
    } catch (e: IllegalArgumentException) {
      promise.reject(ERR_INVALID, e.message ?: "IllegalArgumentException", e)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Unknown error", e)
    }
  }

  @ReactMethod
  fun pickSaveDirectory(promise: Promise) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      }
      val current = getCurrentActivity()
      if (current == null) {
        promise.reject(ERR_NO_ACTIVITY, "No current activity to launch picker")
        return
      }
      current.startActivityForResult(intent, REQ_PICK_TREE)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Failed to launch picker", e)
    }
  }

  // Pending promise that holds the resolution for the text-file picker.
  // MainActivity.onActivityResult calls consumePickTextPromise() and, if
  // non-null, resolves it with the picked file's content (or null on cancel).
  private var pendingPickTextPromise: Promise? = null
  // Timer handle for the picker self-healing timeout (see pickTextFile).
  private var pendingPickTextTimeout: Runnable? = null

  /**
   * Open the system SAF text-file picker. Returns the picked file as
   * `{uri, name, content}` (UTF-8 with BOM stripped), or `null` if the user
   * cancelled the picker.
   */
  @ReactMethod
  fun pickTextFile(promise: Promise) {
    try {
      val current = getCurrentActivity()
      if (current == null) {
        promise.reject(ERR_NO_ACTIVITY, "No current activity to launch picker")
        return
      }
      if (pendingPickTextPromise != null) {
        promise.reject(ERR_UNKNOWN, "Another text-file picker is already open")
        return
      }
      // Set BOTH `type` and `EXTRA_MIME_TYPES`: the Android documents UI
      // honours the EXTRA_MIME_TYPES array, while some OEM pickers (MIUI's
      // "文件管理") only honour `type`. Together they cover both.
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/plain", "text/*"))
      }
      pendingPickTextPromise = promise
      try {
        current.startActivityForResult(intent, REQ_PICK_TEXT)
      } catch (e: Throwable) {
        // Couldn't even start the picker (e.g. no app to handle the
        // intent). Clear the pending promise so the next attempt isn't
        // blocked.
        pendingPickTextPromise = null
        promise.reject(ERR_UNKNOWN, e.message ?: "Failed to launch picker", e)
        return
      }
      // Self-healing timeout: if the activity result never arrives
      // (MIUI sometimes dismisses the picker without firing onActivityResult,
      // or the user kills the picker task), clear the pending promise so
      // a subsequent `pickTextFile` call doesn't see it as "still open".
      pendingPickTextTimeout = Runnable {
        if (pendingPickTextPromise != null) {
          pendingPickTextPromise = null
        }
        pendingPickTextTimeout = null
      }
      mainHandler.postDelayed(pendingPickTextTimeout!!, PICK_TIMEOUT_MS)
    } catch (e: Throwable) {
      pendingPickTextPromise = null
      promise.reject(ERR_UNKNOWN, e.message ?: "Failed to launch picker", e)
    }
  }

  /**
   * Called from MainActivity.onActivityResult when the SAF text-file picker
   * returns. Reads the file content (UTF-8, BOM stripped) and resolves the
   * pending Promise. Returns `null` if there is no pending promise (e.g. the
   * caller cancelled before the picker returned).
   */
  fun consumePickTextPromise(): Promise? {
    val p = pendingPickTextPromise
    pendingPickTextPromise = null
    // Cancel the self-healing timeout — we're settling the promise now.
    pendingPickTextTimeout?.let { mainHandler.removeCallbacks(it) }
    pendingPickTextTimeout = null
    return p
  }

  /**
   * Read the given content URI as UTF-8 text, stripping a leading BOM if
   * present. Public so MainActivity can call it after resolving the SAF
   * picker result.
   */
  fun readPickedText(uri: Uri): String {
    val cr = reactApplicationContext.contentResolver
    return cr.openInputStream(uri)?.use { input ->
      val raw = input.readBytes()
      val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
      val start = if (raw.size >= 3 &&
          raw[0] == bom[0] && raw[1] == bom[1] && raw[2] == bom[2]) 3 else 0
      String(raw, start, raw.size - start, Charsets.UTF_8)
    } ?: ""
  }

  /** Resolve the supplied text-file Promise with `{uri, name, content}` or null. */
  fun resolvePickText(
      promise: Promise,
      uriString: String?,
      name: String?,
      content: String?,
  ) {
    if (uriString == null) {
      promise.resolve(null)
      return
    }
    val out = WritableNativeMap()
    out.putString("uri", uriString)
    out.putString("name", name ?: "")
    out.putString("content", content ?: "")
    promise.resolve(out)
  }

  @ReactMethod
  fun persistPickedTreeUri(uri: String, promise: Promise) {
    try {
      val u = Uri.parse(uri)
      reactApplicationContext.contentResolver.takePersistableUriPermission(
          u,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Failed to persist tree permission", e)
    }
  }

  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

  /**
   * Delete media entries by URI. Used by "删除记录和图片" in 下载记录详情.
   *
   * Handles both MediaStore `content://` URIs and legacy `file://` paths.
   * Resolves with the number of entries actually removed. Best-effort per
   * item: files owned by another install of the app cannot be deleted (the
   * platform refuses), and those are simply counted as failures.
   */
  @ReactMethod
  fun deleteGalleryImages(uris: ReadableArray, promise: Promise) {
    Thread {
          var deleted = 0
          val resolver = reactApplicationContext.contentResolver
          for (i in 0 until uris.size()) {
            val uriString = uris.getString(i) ?: continue
            try {
              val uri = Uri.parse(uriString)
              val removed =
                  when (uri.scheme?.lowercase()) {
                    "content" -> resolver.delete(uri, null, null)
                    "file" -> {
                      val path = uri.path
                      if (path != null && File(path).delete()) 1 else 0
                    }
                    else -> 0
                  }
              if (removed > 0) deleted += 1
            } catch (_: Throwable) {
              // Skip this item; the caller only needs the aggregate count.
            }
          }
          promise.resolve(deleted)
        }
        .start()
  }

  /**
   * Download [url] straight to [targetPath] with OkHttp on a background thread
   * — the transfer never touches the JS thread.
   *
   * Why native: aggressive OEM power managers (MIUI/HyperOS, EMUI, ColorOS)
   * freeze a backgrounded app's JS thread even while a foreground service and
   * a wake lock are held. The JS `fetch`-based path then stalls until the app
   * returns to the foreground (observed: a request issued in the background
   * completed only 170s later, right after the app was resumed). Keeping the
   * transfer here lets bytes keep flowing while JS is frozen; JS just gets the
   * completion callback on its next wake-up.
   *
   * Resolves with `{status, bytes, contentType}`; rejects on HTTP/network/IO
   * errors. `headers` carries the same Referer/UA used by the JS path.
   */
  @ReactMethod
  fun downloadToCache(
      url: String,
      targetPath: String,
      headers: ReadableMap?,
      timeoutMs: Double,
      promise: Promise,
  ) {
    val timeout = if (timeoutMs.isFinite() && timeoutMs > 0) timeoutMs.toLong() else 60_000L
    Thread {
          try {
            val client =
                httpClient
                    .newBuilder()
                    .connectTimeout(timeout, TimeUnit.MILLISECONDS)
                    .readTimeout(timeout, TimeUnit.MILLISECONDS)
                    .callTimeout(timeout, TimeUnit.MILLISECONDS)
                    .build()
            val builder = Request.Builder().url(url).get()
            headers?.let { map ->
              val keys = map.keySetIterator()
              while (keys.hasNextKey()) {
                val key = keys.nextKey()
                val value = map.getString(key)
                if (!value.isNullOrEmpty()) builder.header(key, value)
              }
            }
            client.newCall(builder.build()).execute().use { resp ->
              // Always resolve with the status so JS can classify HTTP errors
              // (hotlink block vs. plain 404) exactly like the fetch path.
              if (!resp.isSuccessful) {
                val err = Arguments.createMap()
                err.putInt("status", resp.code)
                err.putDouble("bytes", 0.0)
                err.putString("contentType", resp.body?.contentType()?.toString() ?: "")
                promise.resolve(err)
                return@use
              }
              val body = resp.body
              if (body == null) {
                promise.reject(ERR_UNKNOWN, "empty response body")
                return@use
              }
              val target = File(targetPath)
              target.parentFile?.mkdirs()
              body.byteStream().use { input ->
                FileOutputStream(target).use { output -> input.copyTo(output) }
              }
              val out = Arguments.createMap()
              out.putInt("status", resp.code)
              out.putDouble("bytes", target.length().toDouble())
              out.putString("contentType", body.contentType()?.toString() ?: "")
              promise.resolve(out)
            }
          } catch (e: Throwable) {
            promise.reject(ERR_UNKNOWN, e.message ?: "download failed", e)
          }
        }
        .start()
  }

  /**
   * List content:// URIs of images that live under a MediaStore RELATIVE_PATH
   * prefixed with [relativePathPrefix] (e.g. "Pictures/TelegraphDownloader/...").
   * Used by the history detail screen as a fallback when the history row has no
   * recorded image_paths (e.g. an image was downloaded but the row predates the
   * per-image detail columns, or a re-run skipped everything and the URI list
   * was empty). Returns [] on Android < Q or for custom-tree storage.
   */
  @ReactMethod
  fun listGalleryImages(relativePathPrefix: String, promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve(Arguments.createArray())
        return
      }
      val resolver: ContentResolver = reactApplicationContext.contentResolver
      val prefix = relativePathPrefix.trim()
      val projection = arrayOf(
          MediaStore.MediaColumns.RELATIVE_PATH,
          MediaStore.Images.ImageColumns._ID,
      )
      val selection: String
      val selectionArgs: Array<String>
      if (prefix.isEmpty()) {
        // No prefix: match BOTH roots (Pictures and Download). The old code
        // hardcoded the Pictures root, which silently returned nothing for
        // users whose storageType is 'downloads'.
        selection =
            BASE_RELATIVE_PATHS.joinToString(" OR ") {
              "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
            }
        selectionArgs = BASE_RELATIVE_PATHS.map { "$it/%" }.toTypedArray()
      } else {
        // Escaping only matters if the prefix contains %, _, or the escape char.
        val escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        selection =
            "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? ESCAPE '\\'"
        selectionArgs = arrayOf("%$escaped%")
      }
      val cursor = try {
        resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            "${MediaStore.Images.ImageColumns.DATE_TAKEN} ASC, ${MediaStore.MediaColumns._ID} ASC",
        )
      } catch (_: Throwable) {
        null
      }
      val out = Arguments.createArray()
      if (cursor != null) {
        cursor.use {
          while (it.moveToNext()) {
            // The WHERE clause already restricts to our app folders / prefix,
            // so no extra (and root-hardcoded) filter is applied here.
            val rel = it.getString(0) ?: continue
            if (rel.isNotEmpty()) {
              // Build a stable content URI: content://media/external/images/media/<id>
              val id = it.getLong(1)
              out.pushString(
                  Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString())
                      .toString()
              )
            }
          }
        }
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Failed to list gallery images", e)
    }
  }

  /**
   * Move every image that currently lives in a per-article subfolder of the
   * app's base folder up into the base folder itself, then best-effort delete
   * the now-empty subfolders.
   *
   * Critically, on Android Q+ this uses ContentResolver.update(RELATIVE_PATH)
   * which preserves the media row's `_ID`. Content URIs stored in the history
   * table therefore remain valid, and the URL-keyed downloaded ledger is
   * untouched — so history and duplicate detection are unaffected.
   */
  @ReactMethod
  fun migrateImagesToBase(promise: Promise) {
    try {
      val result =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) migrateOnAndroidQ()
          else migrateOnAndroidLegacy()
      promise.resolve(result)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Failed to migrate images", e)
    }
  }

  private fun migrateOnAndroidQ(): WritableMap {
    val resolver: ContentResolver = reactApplicationContext.contentResolver
    var moved = 0
    var errors = 0
    val dirsToDelete = LinkedHashSet<String>() // absolute filesystem paths

    for (base in BASE_RELATIVE_PATHS) {
      val baseTrim = base.trimEnd('/')
      val rows = mutableListOf<Triple<Long, String, String>>() // id, rel, name
      val projection =
          arrayOf(
              MediaStore.Images.ImageColumns._ID,
              MediaStore.MediaColumns.RELATIVE_PATH,
              MediaStore.MediaColumns.DISPLAY_NAME,
          )
      val selection = "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
      val cursor =
          try {
            resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                selection,
                arrayOf("$baseTrim/%"),
                null,
            )
          } catch (_: Throwable) {
            null
          }
      cursor?.use {
        while (it.moveToNext()) {
          val rel = it.getString(1) ?: continue
          val name = it.getString(2) ?: continue
          rows.add(Triple(it.getLong(0), rel, name))
        }
      }
      if (rows.isEmpty()) continue

      // Names already directly in the base folder + ones moved during this run,
      // so we can pre-empt MediaProvider's automatic rename and keep names tidy.
      val usedNames = mutableSetOf<String>()
      for ((_, rel, name) in rows) {
        if (rel.trimEnd('/') == baseTrim) usedNames.add(name.lowercase())
      }

      for ((id, rel, name) in rows) {
        val relNorm = rel.trimEnd('/')
        if (relNorm == baseTrim) continue
        if (!relNorm.startsWith("$baseTrim/")) continue
        val unique = uniqueDisplayName(usedNames, name)
        usedNames.add(unique.lowercase())
        val values =
            ContentValues().apply {
              put(MediaStore.MediaColumns.RELATIVE_PATH, "$baseTrim/")
              if (unique != name) put(MediaStore.MediaColumns.DISPLAY_NAME, unique)
            }
        val itemUri =
            ContentUris.withAppendedId(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                id,
            )
        try {
          val updated = resolver.update(itemUri, values, null, null)
          if (updated > 0) {
            moved += 1
            physicalDir(base, relNorm.removePrefix("$baseTrim/"))?.let {
              dirsToDelete.add(it.absolutePath)
            }
          } else {
            errors += 1
          }
        } catch (_: Throwable) {
          errors += 1
        }
      }
    }

    val (dirsDeleted, dirsRemaining) = deleteEmptyDirs(dirsToDelete)
    val out = WritableNativeMap()
    out.putInt("moved", moved)
    out.putInt("dirsDeleted", dirsDeleted)
    out.putInt("dirsRemaining", dirsRemaining)
    out.putInt("errors", errors)
    return out
  }

  /**
   * Best-effort migration for Android 7-9 (legacy File API). Moves files out of
   * every subfolder of the app base folders into the base folder itself.
   */
  private fun migrateOnAndroidLegacy(): WritableMap {
    var moved = 0
    var errors = 0
    var dirsDeleted = 0
    var dirsRemaining = 0
    for (base in BASE_RELATIVE_PATHS) {
      val baseDir = legacyBaseDir(base) ?: continue
      if (!baseDir.isDirectory) continue
      val subDirs = baseDir.listFiles()?.filter { it.isDirectory } ?: emptyList()
      for (sub in subDirs) {
        val files = sub.listFiles()?.filter { it.isFile } ?: emptyList()
        for (file in files) {
          val target = uniqueFile(File(baseDir, file.name))
          val ok =
              try {
                if (file.renameTo(target)) true
                else {
                  file.inputStream().use { input ->
                    target.outputStream().use { output -> copyStream(input, output) }
                  }
                  file.delete()
                }
              } catch (_: Throwable) {
                false
              }
          if (ok) moved += 1 else errors += 1
        }
        if (sub.listFiles()?.isEmpty() != false) {
          if (sub.delete()) dirsDeleted += 1 else dirsRemaining += 1
        } else {
          dirsRemaining += 1
        }
      }
    }
    val out = WritableNativeMap()
    out.putInt("moved", moved)
    out.putInt("dirsDeleted", dirsDeleted)
    out.putInt("dirsRemaining", dirsRemaining)
    out.putInt("errors", errors)
    return out
  }

  private fun uniqueDisplayName(usedLowercase: Set<String>, name: String): String {
    if (!usedLowercase.contains(name.lowercase())) return name
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var n = 1
    while (true) {
      val candidate = "$stem ($n)$ext"
      if (!usedLowercase.contains(candidate.lowercase())) return candidate
      n += 1
    }
  }

  private fun uniqueFile(desired: File): File {
    if (!desired.exists()) return desired
    val dot = desired.name.lastIndexOf('.')
    val stem = if (dot > 0) desired.name.substring(0, dot) else desired.name
    val ext = if (dot > 0) desired.name.substring(dot) else ""
    var n = 1
    while (true) {
      val candidate = File(desired.parentFile, "$stem ($n)$ext")
      if (!candidate.exists()) return candidate
      n += 1
    }
  }

  /** Physical directory for a RELATIVE_PATH like "Pictures/TelegraphDownloader/sub". */
  private fun physicalDir(relativeBase: String, subPath: String): File? {
    val root =
        when {
          relativeBase.startsWith("Pictures/") ->
              Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
          relativeBase.startsWith("Download/") ->
              Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
          else -> null
        } ?: return null
    val baseUnderRoot = relativeBase.substringAfter('/')
    val baseDir = File(root, baseUnderRoot)
    return if (subPath.isEmpty()) baseDir else File(baseDir, subPath)
  }

  private fun legacyBaseDir(relativeBase: String): File? =
      physicalDir(relativeBase, "")

  /** Delete the given dirs deepest-first; returns (deleted, remaining). */
  private fun deleteEmptyDirs(dirs: Set<String>): Pair<Int, Int> {
    var deleted = 0
    var remaining = 0
    val ordered = dirs.sortedByDescending { it.length }
    for (path in ordered) {
      val dir = File(path)
      if (!dir.exists() || !dir.isDirectory) continue
      val empty = dir.listFiles()?.isEmpty() != false
      if (empty && dir.delete()) deleted += 1 else remaining += 1
    }
    return deleted to remaining
  }

  fun handlePickedTreeUri(uri: String) {
    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(
          Uri.parse(uri),
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
    } catch (_: Throwable) {
    }
    val ctx = reactApplicationContext
    if (ctx.hasActiveReactInstance()) {
      val payload: WritableMap = Arguments.createMap()
      payload.putString("uri", uri)
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_TREE_PICKED, payload)
    }
  }

  private fun saveOnAndroidQ(
      source: File,
      subfolder: String,
      filename: String,
      mimeType: String,
      basePath: String,
  ): Uri {
    val resolver: ContentResolver = reactApplicationContext.contentResolver

    val relativePath =
        if (subfolder.isEmpty()) basePath
        else "$basePath/$subfolder"

    val mediaDetails = ContentValues().apply {
      put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
      put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
      put(Images.Media.DISPLAY_NAME, filename)
      put(Images.Media.IS_PENDING, 1)
    }

    val mediaUri =
        resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mediaDetails)
            ?: throw IOException(
                "ContentResolver#insert returned null for RELATIVE_PATH=$relativePath"
            )

    try {
      resolver.openOutputStream(mediaUri).use { output ->
        if (output == null) {
          throw IOException("ContentResolver#openOutputStream returned null")
        }
        FileInputStream(source).use { input -> copyStream(input, output) }
      }
      val updateValues = ContentValues().apply { put(Images.Media.IS_PENDING, 0) }
      resolver.update(mediaUri, updateValues, null, null)
      return mediaUri
    } catch (t: Throwable) {
      try {
        resolver.delete(mediaUri, null, null)
      } catch (_: Throwable) {
      }
      throw t
    }
  }

  private fun saveOnAndroidLegacy(
      source: File,
      subfolder: String,
      filename: String,
      mimeType: String,
      basePath: String,
  ): Uri {
    // basePath is "Pictures/TelegraphDownloader" or "Download/TelegraphDownloader";
    // derive the Environment directory and the folder name from it.
    val rootDirName = basePath.substringBefore('/')  // "Pictures" or "Download"
    val folderName = basePath.substringAfter('/')     // "TelegraphDownloader"
    val rootDir = Environment.getExternalStoragePublicDirectory(rootDirName)
    val targetDir =
        if (subfolder.isEmpty()) File(rootDir, folderName)
        else File(rootDir, "$folderName/$subfolder")

    if (!targetDir.exists() && !targetDir.mkdirs()) {
      throw IOException("Failed to create directory: ${targetDir.absolutePath}")
    }

    val targetFile = File(targetDir, filename)
    FileInputStream(source).use { input ->
      targetFile.outputStream().use { output -> copyStream(input, output) }
    }

    val uri = Uri.fromFile(targetFile)
    reactApplicationContext
        .sendBroadcast(android.content.Intent(android.content.Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, uri))
    return uri
  }

  private fun saveToCustomTree(
      source: File,
      subfolder: String,
      filename: String,
      mimeType: String,
      treeUri: String,
  ): Uri {
    val resolver = reactApplicationContext.contentResolver
    val tree = Uri.parse(treeUri)
    val treeDocId = try { DocumentsContract.getTreeDocumentId(tree) } catch (_: Throwable) { null }
    val treeDocUri = if (treeDocId != null) DocumentsContract.buildDocumentUriUsingTree(tree, treeDocId) else tree

    // Ensure TelegraphDownloader folder exists under the tree root
    val appFolderUri = getOrCreateChildDir(resolver, tree, treeDocUri, BASE_FOLDER) ?: throw IOException("Failed to ensure app folder")

    val targetDirUri = if (subfolder.isEmpty() || subfolder == BASE_RELATIVE_PATH) {
      appFolderUri
    } else {
      // subfolder here is like "Pictures/TelegraphDownloader/<name>" or just relative path; extract leaf
      val leaf = subfolder.substringAfterLast('/').ifEmpty { subfolder }
      getOrCreateChildDir(resolver, tree, appFolderUri, leaf) ?: appFolderUri
    }

    val fileUri = DocumentsContract.createDocument(resolver, targetDirUri, mimeType, filename)
        ?: throw IOException("createDocument returned null")

    resolver.openOutputStream(fileUri)?.use { output ->
      FileInputStream(source).use { input -> copyStream(input, output) }
    } ?: throw IOException("openOutputStream returned null")

    reactApplicationContext.sendBroadcast(
        Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, fileUri),
    )
    return fileUri
  }

  private fun getOrCreateChildDir(
      resolver: ContentResolver,
      tree: Uri,
      parentUri: Uri,
      displayName: String,
  ): Uri? {
    val existingId = findFileId(resolver, parentUri, displayName)
    if (existingId != null) {
      return DocumentsContract.buildDocumentUriUsingTree(tree, existingId)
    }
    return try {
      DocumentsContract.createDocument(resolver, parentUri, DocumentsContract.Document.MIME_TYPE_DIR, displayName)
    } catch (_: Throwable) {
      null
    }
  }

  private fun findFileId(
      resolver: ContentResolver,
      parentUri: Uri,
      displayName: String,
  ): String? {
    val cursor = try {
      resolver.query(
          parentUri,
          arrayOf(
              DocumentsContract.Document.COLUMN_DOCUMENT_ID,
              DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          ),
          null,
          null,
          null,
      )
    } catch (_: Throwable) { null } ?: return null
    cursor.use {
      while (it.moveToNext()) {
        val id = it.getString(0) ?: continue
        val name = it.getString(1) ?: continue
        if (name == displayName) return id
      }
    }
    return null
  }

  private fun copyStream(input: FileInputStream, output: OutputStream) {
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n <= 0) break
      output.write(buf, 0, n)
    }
    output.flush()
  }

  private fun inferMimeType(filename: String, source: File): String {
    val ext = filename.substringAfterLast('.', "").lowercase()
    return when (ext) {
      "jpg",
      "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "webp" -> "image/webp"
      "gif" -> "image/gif"
      "bmp" -> "image/bmp"
      "heic" -> "image/heic"
      "heif" -> "image/heif"
      "avif" -> "image/avif"
      else -> "image/jpeg"
    }
  }

  private fun sanitizePathSegment(input: String): String {
    if (input.isEmpty()) return ""
    val cleaned =
        input
            .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_")
            .replace(Regex("\\.+$"), "")
            .trim()
    return cleaned
  }

  companion object {
    const val NAME = "TelegraphDownloader"

    private const val BASE_FOLDER = "TelegraphDownloader"
    private const val BASE_RELATIVE_PATH = "Pictures/$BASE_FOLDER"
    private const val BASE_RELATIVE_PATH_DOWNLOAD = "Download/$BASE_FOLDER"
    private val BASE_RELATIVE_PATHS =
        listOf("Pictures/$BASE_FOLDER", "Download/$BASE_FOLDER")

    const val ERR_INVALID = "ERR_INVALID_FILENAME"
    const val ERR_NOT_FOUND = "ERR_SOURCE_NOT_FOUND"
    const val ERR_EMPTY = "ERR_SOURCE_EMPTY"
    const val ERR_IO = "ERR_IO"
    const val ERR_PERMISSION = "ERR_PERMISSION"
    const val ERR_NO_ACTIVITY = "ERR_NO_ACTIVITY"
    const val ERR_UNKNOWN = "ERR_UNKNOWN"
    const val ERR_HTTP = "ERR_HTTP"

    const val REQ_PICK_TREE = 0x7744
    const val REQ_PICK_TEXT = 0x7745
    const val EVENT_TREE_PICKED = "TelegraphDownloader:treePicked"

    // Maximum time to wait for the text-file picker to return before the
    // pending promise is considered stale and silently dropped.
    private const val PICK_TIMEOUT_MS = 120_000L

    // Static reference to the most-recently-instantiated module, populated
    // in `init`. Used by MainActivity (and any other lifecycle hook) to
    // resolve the module without going through `application as ReactApplication`
    // (which can fail when `reactHost.currentReactContext` is transiently
    // null in bridgeless mode). Cleared in `invalidate`.
    @Volatile
    private var instance: TelegraphDownloaderModule? = null

    /** Returns the current module instance, or null if none. */
    fun getInstance(): TelegraphDownloaderModule? = instance
  }
}
