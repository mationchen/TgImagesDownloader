package com.acstd.tgimagesdownloader.downloader

import android.content.ContentResolver
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
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.OutputStream

/**
 * Native bridge that copies a local image file into MediaStore so it shows
 * up in the system gallery under Pictures/TelegraphDownloader/<subfolder>/.
 */
class TelegraphDownloaderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun saveImageToMediaStore(
      localFilePath: String,
      subfolder: String,
      filename: String,
      customTreeUri: String,
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
          when {
            customTreeUri.isNotEmpty() -> saveToCustomTree(source, safeSubfolder, safeFilename, mimeType, customTreeUri)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> saveOnAndroidQ(source, safeSubfolder, safeFilename, mimeType)
            else -> saveOnAndroidLegacy(source, safeSubfolder, safeFilename, mimeType)
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
        selection = "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
        selectionArgs = arrayOf("$BASE_RELATIVE_PATH/%")
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
            val rel = it.getString(0) ?: continue
            if (rel.startsWith(BASE_RELATIVE_PATH)) {
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

    const val ERR_INVALID = "ERR_INVALID_FILENAME"
    const val ERR_NOT_FOUND = "ERR_SOURCE_NOT_FOUND"
    const val ERR_EMPTY = "ERR_SOURCE_EMPTY"
    const val ERR_IO = "ERR_IO"
    const val ERR_PERMISSION = "ERR_PERMISSION"
    const val ERR_NO_ACTIVITY = "ERR_NO_ACTIVITY"
    const val ERR_UNKNOWN = "ERR_UNKNOWN"

    const val REQ_PICK_TREE = 0x7744
    const val EVENT_TREE_PICKED = "TelegraphDownloader:treePicked"
  }
}
