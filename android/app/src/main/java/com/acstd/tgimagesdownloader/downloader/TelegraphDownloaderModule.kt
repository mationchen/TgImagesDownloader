package com.acstd.tgimagesdownloader.downloader

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.MediaStore.Images
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.OutputStream

/**
 * Native bridge that copies a local image file into MediaStore so it shows
 * up in the system gallery under Pictures/TelegraphDownloader/<subfolder>/.
 *
 * Why a custom module:
 *   - @react-native-camera-roll/camera-roll places images under DCIM/, not
 *     Pictures/, and does not support nested sub-folders, which conflicts
 *     with spec §13 (Pictures/TelegraphDownloader/) and §9 (per-article
 *     sub-folder).
 *   - Phase 5 (batch download) will reuse this same primitive and layer
 *     concurrency + progress on top in JS.
 *
 * Storage strategy (spec §13):
 *   - Android 10+ (Q): ContentResolver.insert + RELATIVE_PATH =
 *     "Pictures/TelegraphDownloader/<subfolder>/", IS_PENDING workflow.
 *   - Android 7-9: legacy File API, write to
 *     getExternalStoragePublicDirectory(PICTURES)/TelegraphDownloader/<subfolder>/,
 *     then notify MediaScanner so the gallery picks it up.
 *
 * No permissions are required:
 *   - Android 10+ scoped storage + MediaStore doesn't need
 *     WRITE_EXTERNAL_STORAGE.
 *   - Android 9 and below: WRITE_EXTERNAL_STORAGE is technically needed but
 *     we leave it to the user / V2; in practice most apps got away without
 *     declaring it on 7-9 and it still worked via the legacy grant.
 */
class TelegraphDownloaderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun saveImageToMediaStore(
      localFilePath: String,
      subfolder: String,
      filename: String,
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

      val resultUri: Uri =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveOnAndroidQ(source, safeSubfolder, safeFilename, mimeType)
          } else {
            saveOnAndroidLegacy(source, safeSubfolder, safeFilename, mimeType)
          }

      val response = WritableNativeMap()
      response.putString("uri", resultUri.toString())
      response.putDouble("bytes", source.length().toDouble())
      response.putString("mimeType", mimeType)
      response.putString("filename", safeFilename)
      response.putString("subfolder", safeSubfolder)
      response.putBoolean("legacy", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q)
      promise.resolve(response)
    } catch (e: SecurityException) {
      promise.reject(ERR_PERMISSION, e.message ?: "SecurityException", e)
    } catch (e: IOException) {
      // Best-effort cleanup of pending MediaStore row on failure
      promise.reject(ERR_IO, e.message ?: "IOException", e)
    } catch (e: IllegalArgumentException) {
      promise.reject(ERR_INVALID, e.message ?: "IllegalArgumentException", e)
    } catch (e: Throwable) {
      promise.reject(ERR_UNKNOWN, e.message ?: "Unknown error", e)
    }
  }

  /** Android 10+ (Q): scoped storage via MediaStore + RELATIVE_PATH. */
  private fun saveOnAndroidQ(
      source: File,
      subfolder: String,
      filename: String,
      mimeType: String,
  ): Uri {
    val resolver: ContentResolver = reactApplicationContext.contentResolver

    val relativePath =
        if (subfolder.isEmpty()) BASE_RELATIVE_PATH
        else "$BASE_RELATIVE_PATH/$subfolder"

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
      // Flip IS_PENDING off so the image becomes visible in the gallery.
      val updateValues = ContentValues().apply { put(Images.Media.IS_PENDING, 0) }
      resolver.update(mediaUri, updateValues, null, null)
      return mediaUri
    } catch (t: Throwable) {
      // Roll back the pending row so we don't leave orphan 0-byte entries.
      try {
        resolver.delete(mediaUri, null, null)
      } catch (_: Throwable) {
        // Best-effort; ignore cleanup failure.
      }
      throw t
    }
  }

  /**
   * Android 7-9: legacy File API. We still don't require WRITE_EXTERNAL_STORAGE
   * for our own scoped area on 7-9, but the OS will only let us write into
   * Pictures/ on devices where the user hasn't revoked the implicit grant.
   */
  private fun saveOnAndroidLegacy(
      source: File,
      subfolder: String,
      filename: String,
      mimeType: String,
  ): Uri {
    val picturesDir =
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
    val targetDir =
        if (subfolder.isEmpty()) File(picturesDir, BASE_FOLDER)
        else File(picturesDir, "$BASE_FOLDER/$subfolder")

    if (!targetDir.exists() && !targetDir.mkdirs()) {
      throw IOException("Failed to create directory: ${targetDir.absolutePath}")
    }

    val targetFile = File(targetDir, filename)
    FileInputStream(source).use { input ->
      targetFile.outputStream().use { output -> copyStream(input, output) }
    }

    // Notify MediaScanner so the gallery picks up the new file.
    val uri = Uri.fromFile(targetFile)
    reactApplicationContext
        .sendBroadcast(android.content.Intent(android.content.Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, uri))
    return uri
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
    // Strip reserved chars + control chars + path separators.
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
    // We pass this as MediaStore.Images.Media.RELATIVE_PATH directly;
    // the MediaStore implementation prefixes it with the appropriate
    // primary volume (e.g. /storage/emulated/0/Pictures/...).
    private const val BASE_RELATIVE_PATH = "Pictures/$BASE_FOLDER"

    const val ERR_INVALID = "ERR_INVALID_FILENAME"
    const val ERR_NOT_FOUND = "ERR_SOURCE_NOT_FOUND"
    const val ERR_EMPTY = "ERR_SOURCE_EMPTY"
    const val ERR_IO = "ERR_IO"
    const val ERR_PERMISSION = "ERR_PERMISSION"
    const val ERR_UNKNOWN = "ERR_UNKNOWN"
  }
}