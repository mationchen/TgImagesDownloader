package com.acstd.tgimagesdownloader.archive

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.charset.Charset
import java.nio.channels.FileChannel
import java.security.MessageDigest
import me.zhanghai.android.libarchive.Archive
import me.zhanghai.android.libarchive.ArchiveEntry
import org.apache.commons.compress.archivers.sevenz.SevenZArchiveEntry
import org.apache.commons.compress.archivers.sevenz.SevenZFile
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.zip.ZipFile
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import org.apache.commons.compress.utils.IOUtils

/**
 * Local archive import ("解压压缩包") support.
 *
 * Formats: ZIP / 7z / TAR(.gz) via commons-compress, RAR via libarchive (which
 * is the only option that reads RAR5, today's WinRAR default).
 *
 * Design notes:
 *  - **No file path.** A picked archive is a `content://` URI, so everything
 *    goes through a file descriptor: commons-compress reads a
 *    SeekableByteChannel, libarchive takes the raw fd.
 *  - **Content identity.** [inspect] returns a fingerprint over the archive's
 *    directory (entry path + size + CRC where available, sorted). The same
 *    archive re-downloaded under a different name therefore yields the same
 *    fingerprint, which the JS side uses as the history row key and as the
 *    per-image ledger prefix.
 *  - **Encrypted archives are not supported** and are reported, not extracted.
 *  - **Limits.** [MAX_ENTRIES] / [MAX_ARCHIVE_BYTES] guard against
 *    pathological archives.
 *
 * Methods:
 *   - pickTree() / listChildren(treeUri): the in-app archive browser
 *   - pickArchives(): system multi-select file picker (MIME-filtered)
 *   - inspect(uri): fingerprint + image entries + flags
 *   - extract(uri, entryPaths): stream entries into the cache
 *   - cancelExtract(): abort the running extraction
 */
class ArchiveModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "TelegraphArchive"

    /** Request codes; must not clash with the downloader's (0x7744/0x7745). */
    const val REQ_PICK_TREE = 0x7746
    const val REQ_PICK_ARCHIVES = 0x7747

    /** Guard rails (see the class KDoc). */
    const val MAX_ENTRIES = 20_000
    const val MAX_ARCHIVE_BYTES = 4L * 1024L * 1024L * 1024L

    /** Progress tick emitted while extracting. */
    const val EVENT_PROGRESS = "TgArchive:progress"

    /** How many entries to extract between progress events. */
    private const val PROGRESS_EVERY = 5

    /** libarchive's default read block size. */
    private const val ARCHIVE_BLOCK_SIZE = 10240L

    /** libarchive `AE_IFDIR`. */
    private const val AE_IFDIR = 0x4000

  /** Media we extract from archives: images, plus videos (archives often hold both). */
  private val MEDIA_EXTENSIONS =
      setOf(
          // images
          "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif",
          // videos
          "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ts",
      )

    /**
     * MIME types offered to the system file picker. `octet-stream` is included
     * on purpose: several Android versions have no `.rar` mapping, so a rar file
     * is advertised as `octet-stream` and would otherwise be filtered out of
     * the picker entirely.
     */
    private val ARCHIVE_MIME_TYPES =
        arrayOf(
            "application/zip",
            "application/x-zip-compressed",
            "application/x-zip",
            "application/vnd.rar",
            "application/x-rar-compressed",
            "application/x-rar",
            "application/x-7z-compressed",
            "application/x-tar",
            "application/gzip",
            "application/x-gzip",
            "application/vnd.comicbook+zip",
            "application/vnd.comicbook-rar",
            "application/octet-stream",
        )

    @Volatile private var instance: ArchiveModule? = null

    fun getInstance(): ArchiveModule? = instance
  }

  /** Pending promise for [pickTree]; resolved from MainActivity's result. */
  private var pendingTreePromise: Promise? = null

  /** Pending promise for [pickArchives]; resolved from MainActivity's result. */
  private var pendingArchivePromise: Promise? = null

  /** Cooperative cancellation flag for the running [extract]. */
  @Volatile private var cancelRequested = false

  init {
    instance = this
  }

  override fun getName(): String = NAME

  override fun invalidate() {
    super.invalidate()
    pendingTreePromise = null
    pendingArchivePromise = null
    if (instance === this) instance = null
  }

  /* ------------------------------------------------------------------ */
  /* File picking + browsing                                             */
  /* ------------------------------------------------------------------ */

  /** Open the system directory picker so the user can choose where to browse. */
  @ReactMethod
  fun pickTree(promise: Promise) {
    val activity = getCurrentActivity()
    if (activity == null) {
      promise.reject("ERR_NO_ACTIVITY", "No current activity to launch picker")
      return
    }
    if (pendingTreePromise != null) {
      promise.reject("ERR_BUSY", "Another directory picker is already open")
      return
    }
    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
    pendingTreePromise = promise
    try {
      activity.startActivityForResult(intent, REQ_PICK_TREE)
    } catch (e: Throwable) {
      pendingTreePromise = null
      promise.reject("ERR_PICKER", e.message ?: "Failed to launch picker", e)
    }
  }

  /** Called from MainActivity.onActivityResult(REQ_PICK_TREE). */
  fun consumePickedTree(uri: Uri?) {
    val promise = pendingTreePromise
    pendingTreePromise = null
    if (promise == null) return
    if (uri == null) {
      promise.resolve(null)
      return
    }
    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    } catch (_: Throwable) {
      // Non-fatal: the grant still lasts for this session.
    }
    val out = Arguments.createMap()
    out.putString("uri", uri.toString())
    out.putString("name", DocumentFile.fromTreeUri(reactApplicationContext, uri)?.name ?: "")
    promise.resolve(out)
  }

  /**
   * Open the system **file** picker for archives, allowing one or many files.
   *
   * `EXTRA_MIME_TYPES` pre-filters the list on most ROMs. Some OEM pickers
   * (notably MIUI's file manager) ignore it and show every file, so the JS side
   * validates extensions and reports anything that isn't an archive.
   */
  @ReactMethod
  fun pickArchives(promise: Promise) {
    val activity = getCurrentActivity()
    if (activity == null) {
      promise.reject("ERR_NO_ACTIVITY", "No current activity to launch picker")
      return
    }
    if (pendingArchivePromise != null) {
      promise.reject("ERR_BUSY", "Another file picker is already open")
      return
    }
    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          // `type` must be "*/*" for EXTRA_MIME_TYPES to be honoured, and is
          // also what OEM pickers that ignore the extras fall back to.
          type = "*/*"
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          putExtra(Intent.EXTRA_MIME_TYPES, ARCHIVE_MIME_TYPES)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
    pendingArchivePromise = promise
    try {
      activity.startActivityForResult(intent, REQ_PICK_ARCHIVES)
    } catch (e: Throwable) {
      pendingArchivePromise = null
      promise.reject("ERR_PICKER", e.message ?: "Failed to launch picker", e)
    }
  }

  /** Called from MainActivity.onActivityResult(REQ_PICK_ARCHIVES). */
  fun consumePickedArchives(data: Intent?) {
    val promise = pendingArchivePromise ?: return
    pendingArchivePromise = null
    if (data == null) {
      promise.resolve(null)
      return
    }
    try {
      val uris = ArrayList<Uri>()
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) {
          clip.getItemAt(i)?.uri?.let { uris.add(it) }
        }
      }
      if (uris.isEmpty()) {
        data.data?.let { uris.add(it) }
      }
      val out = Arguments.createArray()
      for (uri in uris) {
        try {
          reactApplicationContext.contentResolver.takePersistableUriPermission(
              uri,
              Intent.FLAG_GRANT_READ_URI_PERMISSION,
          )
        } catch (_: Throwable) {
          // Non-fatal: the grant lasts for this session.
        }
        val map = Arguments.createMap()
        map.putString("uri", uri.toString())
        map.putString(
            "name",
            queryColumn(uri, OpenableColumns.DISPLAY_NAME) ?: uri.lastPathSegment ?: "",
        )
        map.putDouble(
            "size",
            (queryColumn(uri, OpenableColumns.SIZE)?.toDoubleOrNull() ?: 0.0),
        )
        out.pushMap(map)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("ERR_PICK", e.message ?: "failed to read the selection", e)
    }
  }

  /** Read one column of a `content://` document as a string. */
  private fun queryColumn(uri: Uri, column: String): String? {
    return try {
      reactApplicationContext.contentResolver
          .query(uri, arrayOf(column), null, null, null)
          ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * List one directory of a SAF tree: `{name, uri, isDirectory, size, modified}`.
   * The caller filters by extension (only archives are shown).
   */
  @ReactMethod
  fun listChildren(treeUri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(treeUri)
      // The root is a `tree` URI while drilled-down folders are `document`
      // URIs; fromTreeUri only understands the former, so fall back.
      val dir =
          DocumentFile.fromTreeUri(reactApplicationContext, parsed)
              ?: DocumentFile.fromSingleUri(reactApplicationContext, parsed)
      if (dir == null || !dir.isDirectory) {
        promise.reject("ERR_TREE", "Cannot open the selected folder")
        return
      }
      val out = Arguments.createArray()
      for (child in dir.listFiles()) {
        val map = Arguments.createMap()
        map.putString("name", child.name ?: "")
        map.putString("uri", child.uri.toString())
        map.putBoolean("isDirectory", child.isDirectory)
        map.putDouble("size", child.length().toDouble())
        map.putDouble("modified", child.lastModified().toDouble())
        out.pushMap(map)
      }
      promise.resolve(out)
    } catch (e: Throwable) {
      promise.reject("ERR_LIST", e.message ?: "Cannot list the folder", e)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inspecting                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Open `uri` and return `{ok, fingerprint, totalEntries, images, encrypted,
   * error, message}`. `images` only holds image entries so the JS side never
   * sees a huge payload.
   */
  @ReactMethod
  fun inspect(uri: String, promise: Promise) {
    Thread {
          try {
            val size = DocumentFile.fromSingleUri(reactApplicationContext, Uri.parse(uri))?.length() ?: 0L
            if (size > MAX_ARCHIVE_BYTES) {
              promise.resolve(errorResult("TOO_LARGE", "archive larger than 4GB"))
              return@Thread
            }
            val reader = openReader(uri)
            reader.use {
              val entries = it.entries()
              if (entries.size > MAX_ENTRIES) {
                promise.resolve(errorResult("TOO_MANY_ENTRIES", "too many entries"))
                return@use
              }
              val images = Arguments.createArray()
              val digestLines = ArrayList<String>(entries.size)
              for (entry in entries) {
                // The fingerprint covers EVERY file entry (not just images) so
                // the identity stays stable if a future version filters
                // differently.
                digestLines.add("${entry.name}|${entry.size}|${entry.crc}")
                if (!isMediaEntry(entry.name)) continue
                val map = Arguments.createMap()
                map.putString("path", entry.name)
                map.putString("name", entry.name.substringAfterLast('/'))
                map.putDouble("size", entry.size.toDouble())
                images.pushMap(map)
              }
              val out = Arguments.createMap()
              out.putBoolean("ok", true)
              out.putString("fingerprint", sha256Hex(digestLines.sorted().joinToString("\n")))
              out.putInt("totalEntries", entries.size)
              out.putArray("images", images)
              out.putBoolean("encrypted", it.encrypted())
              promise.resolve(out)
            }
          } catch (e: EncryptedArchiveException) {
            promise.resolve(errorResult("ENCRYPTED", e.message ?: "needs a password"))
          } catch (e: Throwable) {
            promise.resolve(
                errorResult(
                    "UNREADABLE",
                    e.message ?: e.javaClass.simpleName ?: "cannot read archive",
                ),
            )
          }
        }
        .start()
  }

  /* ------------------------------------------------------------------ */
  /* Extracting                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Stream the requested entries out of `uri` into the app cache.
   *
   * Resolves `{items: [{path, tmpPath, bytes}], failed: [{path, reason}]}` and
   * emits [EVENT_PROGRESS] `{done, total, name}` while working. Cancellable via
   * [cancelExtract]; the partial result is still resolved.
   */
  @ReactMethod
  fun extract(uri: String, entryPaths: ReadableArray, promise: Promise) {
    cancelRequested = false
    val wanted = LinkedHashSet<String>()
    for (i in 0 until entryPaths.size()) {
      entryPaths.getString(i)?.let { wanted.add(it) }
    }
    Thread {
          val items = Arguments.createArray()
          val failed = Arguments.createArray()
          val tmpDir = File(reactApplicationContext.cacheDir, "archive-tmp")
          try {
            tmpDir.deleteRecursively()
            tmpDir.mkdirs()
          } catch (_: Throwable) {
            // keep going; per-item failures are reported below
          }
          val total = wanted.size
          var done = 0
          val seen = HashSet<String>()
          try {
            openReader(uri).use { reader ->
              reader.extract(
                  wanted = wanted,
                  shouldContinue = { !cancelRequested },
                  target = { info ->
                    File(tmpDir, "e${done}_${sanitizeName(info.name)}")
                  },
                  done = { info, file ->
                    seen.add(info.name)
                    try {
                      val map = Arguments.createMap()
                      map.putString("path", info.name)
                      map.putString("tmpPath", file.absolutePath)
                      map.putDouble("bytes", file.length().toDouble())
                      items.pushMap(map)
                    } catch (e: Throwable) {
                      failed.pushMap(failure(info.name, e.message ?: "extract failed"))
                    }
                    done += 1
                    if (done % PROGRESS_EVERY == 0 || done == total) {
                      emitProgress(done, total, info.name)
                    }
                  },
              )
            }
            // Names the reader never produced (missing from the archive).
            for (path in wanted) {
              if (!seen.contains(path)) failed.pushMap(failure(path, "ENTRY_MISSING"))
            }
          } catch (e: EncryptedArchiveException) {
            failed.pushMap(failure("", "ENCRYPTED"))
          } catch (e: Throwable) {
            failed.pushMap(failure("", e.message ?: "cannot open archive"))
          }
          val out = Arguments.createMap()
          out.putArray("items", items)
          out.putArray("failed", failed)
          out.putBoolean("cancelled", cancelRequested)
          promise.resolve(out)
        }
        .start()
  }

  /** Ask the running [extract] to stop after the current entry. */
  @ReactMethod
  fun cancelExtract() {
    cancelRequested = true
  }

  /* ------------------------------------------------------------------ */
  /* Readers                                                             */
  /* ------------------------------------------------------------------ */

  /** One file entry; `crc` is "-" for formats without per-entry checksums. */
  private data class EntryInfo(val name: String, val size: Long, val crc: String)

  /** Read access to an archive; one implementation per container family. */
  private interface ArchiveReader : java.io.Closeable {
    fun entries(): List<EntryInfo>

    /** True when any entry needs a password. */
    fun encrypted(): Boolean

    /**
     * Write every requested entry into its own file (from [target]) and report
     * it through [done]. [shouldContinue] is polled so a cancel unwinds
     * promptly — TAR/RAR have no cheap random access, so a cancelled walk must
     * stop reading rather than drain the whole archive.
     */
    fun extract(
        wanted: Set<String>,
        shouldContinue: () -> Boolean,
        target: (EntryInfo) -> File,
        done: (EntryInfo, File) -> Unit,
    )
  }

  /** ZIP: random access through the central directory (cheap listing + CRCs). */
  private class ZipReader(
      private val zip: ZipFile,
      private val infos: List<EntryInfo>,
      private val enc: Boolean,
  ) : ArchiveReader {
    override fun entries(): List<EntryInfo> = infos

    override fun encrypted(): Boolean = enc

    override fun extract(
        wanted: Set<String>,
        shouldContinue: () -> Boolean,
        target: (EntryInfo) -> File,
        done: (EntryInfo, File) -> Unit,
    ) {
      for (info in infos) {
        if (!shouldContinue()) return
        if (info.name !in wanted) continue
        val entry = zip.getEntry(info.name) ?: continue
        val file = target(info)
        zip.getInputStream(entry).use { input ->
          file.outputStream().use { output -> IOUtils.copy(input, output) }
        }
        done(info, file)
      }
    }

    override fun close() {
      zip.close()
    }
  }

  /** 7z via commons-compress (LZMA/LZMA2; AES only with a password). */
  private class SevenZReader(
      private val sevenZ: SevenZFile,
      private val infos: List<EntryInfo>,
  ) : ArchiveReader {
    override fun entries(): List<EntryInfo> = infos

    override fun encrypted(): Boolean = false

    override fun extract(
        wanted: Set<String>,
        shouldContinue: () -> Boolean,
        target: (EntryInfo) -> File,
        done: (EntryInfo, File) -> Unit,
    ) {
      val byName = HashMap<String, SevenZArchiveEntry>()
      for (entry in sevenZ.entries) byName[entry.name] = entry
      for (info in infos) {
        if (!shouldContinue()) return
        if (info.name !in wanted) continue
        val entry = byName[info.name] ?: continue
        val file = target(info)
        sevenZ.getInputStream(entry).use { input ->
          file.outputStream().use { output -> IOUtils.copy(input, output) }
        }
        done(info, file)
      }
    }

    override fun close() {
      sevenZ.close()
    }
  }

  /**
   * TAR / TAR.GZ: no central directory, so listing and extraction each stream
   * the whole file. [openStream] must hand back a fresh stream every call.
   */
  private class TarReader(
      private val openStream: () -> InputStream,
  ) : ArchiveReader {
    private var cached: List<EntryInfo>? = null

    override fun entries(): List<EntryInfo> {
      cached?.let { return it }
      val out = ArrayList<EntryInfo>()
      openStream().use { raw ->
        TarArchiveInputStream(raw).use { tar ->
          while (true) {
            val entry = tar.nextEntry ?: break
            if (entry.isDirectory) continue
            out.add(EntryInfo(entry.name, entry.size, "-"))
          }
        }
      }
      cached = out
      return out
    }

    override fun encrypted(): Boolean = false

    override fun extract(
        wanted: Set<String>,
        shouldContinue: () -> Boolean,
        target: (EntryInfo) -> File,
        done: (EntryInfo, File) -> Unit,
    ) {
      var remaining = wanted.size
      openStream().use { raw ->
        TarArchiveInputStream(raw).use { tar ->
          while (remaining > 0 && shouldContinue()) {
            val entry = tar.nextEntry ?: break
            if (entry.isDirectory || entry.name !in wanted) continue
            val info = EntryInfo(entry.name, entry.size, "-")
            val file = target(info)
            file.outputStream().use { output -> IOUtils.copy(tar, output) }
            done(info, file)
            remaining -= 1
          }
        }
      }
    }

    override fun close() {
      // Streams are opened per pass, so there is nothing to release.
    }
  }

  /**
   * RAR (and anything else libarchive handles). libarchive is the only reader
   * here that supports RAR5, and its fd-based API fits `content://` URIs.
   */
  private class LibarchiveReader(
      private val openSource: () -> ParcelFileDescriptor,
      private val infos: List<EntryInfo>,
      private val encryptedEntries: Boolean,
  ) : ArchiveReader {
    override fun entries(): List<EntryInfo> = infos

    override fun encrypted(): Boolean = encryptedEntries

    /**
     * Fresh handle **and** fresh descriptor: libarchive read handles are
     * single-pass and `readOpenFd` starts where the descriptor points, so a
     * reused descriptor would begin at EOF after the listing pass.
     */
    private fun openHandle(): Pair<Long, ParcelFileDescriptor> {
      val source = openSource()
      val handle = Archive.readNew()
      try {
        Archive.readSupportFormatAll(handle)
        Archive.readSupportFilterAll(handle)
        Archive.readOpenFd(handle, source.fd, ARCHIVE_BLOCK_SIZE)
      } catch (e: Throwable) {
        try {
          source.close()
        } catch (_: Throwable) {
          // ignore
        }
        throw e
      }
      return handle to source
    }

    override fun extract(
        wanted: Set<String>,
        shouldContinue: () -> Boolean,
        target: (EntryInfo) -> File,
        done: (EntryInfo, File) -> Unit,
    ) {
      val (handle, source) = openHandle()
      try {
        while (shouldContinue()) {
          val entry = Archive.readNextHeader(handle)
          if (entry == 0L) break
          val name = ArchiveEntry.pathnameUtf8(entry) ?: ""
          if (name !in wanted) {
            Archive.readDataSkip(handle)
            continue
          }
          val info = EntryInfo(name, ArchiveEntry.size(entry), "-")
          val file = target(info)
          val sink =
              ParcelFileDescriptor.open(
                  file,
                  ParcelFileDescriptor.MODE_CREATE or
                      ParcelFileDescriptor.MODE_WRITE_ONLY or
                      ParcelFileDescriptor.MODE_TRUNCATE,
              )
          try {
            Archive.readDataIntoFd(handle, sink.fd)
          } finally {
            sink.close()
          }
          done(info, file)
        }
      } finally {
        try {
          Archive.readClose(handle)
        } finally {
          Archive.readFree(handle)
        }
        try {
          source.close()
        } catch (_: Throwable) {
          // ignore
        }
      }
    }

    override fun close() {
      // Descriptors are opened per pass, so there is nothing to release.
    }
  }

  /** Thrown when an archive needs a password (not supported by design). */
  private class EncryptedArchiveException(message: String) : IOException(message)

  /* ------------------------------------------------------------------ */
  /* Opening                                                             */
  /* ------------------------------------------------------------------ */

  /** File name of the picked archive (used to pick a reader by extension). */
  private fun archiveName(uri: String): String =
      try {
        DocumentFile.fromSingleUri(reactApplicationContext, Uri.parse(uri))?.name
            ?: uri.substringAfterLast('/')
      } catch (_: Throwable) {
        uri
      }

  /** Open [uri] with the reader matching its extension. */
  private fun openReader(uri: String): ArchiveReader {
    val name = archiveName(uri).lowercase()
    return when {
      name.endsWith(".7z") || name.endsWith(".7zip") -> openSevenZReader(uri)
      name.endsWith(".rar") || name.endsWith(".cbr") -> openLibarchiveReader(uri)
      name.endsWith(".tar") || name.endsWith(".tgz") || name.endsWith(".tar.gz") ->
          TarReader { openRawStream(uri, name) }
      else -> openZipReader(uri)
    }
  }

  /** Raw (optionally gzip-decompressed) byte stream of the archive. */
  private fun openRawStream(uri: String, name: String): InputStream {
    val base =
        reactApplicationContext.contentResolver.openInputStream(Uri.parse(uri))
            ?: throw IOException("cannot open archive")
    return if (name.endsWith(".gz") || name.endsWith(".tgz")) {
      GzipCompressorInputStream(base)
    } else {
      base
    }
  }

  /**
   * Open a ZIP for random access.
   *
   * Falls back to GBK when the names do not decode as UTF-8, which is common
   * for archives produced on Chinese Windows.
   */
  private fun openZipReader(uri: String): ArchiveReader {
    val utf8 = openZip(openChannel(uri), Charsets.UTF_8)
    val first = zipInfos(utf8)
    if (!first.first.any { it.name.contains('\uFFFD') }) {
      return ZipReader(utf8, first.first, first.second)
    }
    // Reopen with GBK: the names were not UTF-8 after all.
    utf8.close()
    val gbk =
        try {
          Charset.forName("GBK")
        } catch (_: Throwable) {
          Charsets.UTF_8
        }
    val reopened = openZip(openChannel(uri), gbk)
    val infos = zipInfos(reopened)
    return ZipReader(reopened, infos.first, infos.second)
  }

  /** 7z via commons-compress. */
  private fun openSevenZReader(uri: String): ArchiveReader {
    val sevenZ =
        try {
          SevenZFile.builder().setSeekableByteChannel(openChannel(uri)).get()
        } catch (e: Throwable) {
          if (looksEncrypted(e)) throw EncryptedArchiveException("7z needs a password")
          throw IOException(e.message ?: "cannot open 7z archive")
        }
    val infos = ArrayList<EntryInfo>()
    for (entry in sevenZ.entries) {
      if (entry.isDirectory) continue
      infos.add(EntryInfo(entry.name, entry.size, entry.crcValue.toString()))
    }
    return SevenZReader(sevenZ, infos)
  }

  /**
   * RAR via libarchive. libarchive only exposes the format through native code
   * and `readOpenFd` takes exactly what a `content://` archive gives us.
   */
  private fun openLibarchiveReader(uri: String): ArchiveReader {
    val openSource = {
      reactApplicationContext.contentResolver.openFileDescriptor(Uri.parse(uri), "r")
          ?: throw IOException("cannot open archive")
    }
    val source = openSource()
    try {
      val handle = Archive.readNew()
      try {
        Archive.readSupportFormatAll(handle)
        Archive.readSupportFilterAll(handle)
        Archive.readOpenFd(handle, source.fd, ARCHIVE_BLOCK_SIZE)
        val encrypted =
            try {
              Archive.readHasEncryptedEntries(handle) > 0
            } catch (_: Throwable) {
              false
            }
        val infos = ArrayList<EntryInfo>()
        while (true) {
          val entry = Archive.readNextHeader(handle)
          if (entry == 0L) break
          val name = ArchiveEntry.pathnameUtf8(entry) ?: ""
          val isDirectory = (ArchiveEntry.filetype(entry) and 0xF000) == AE_IFDIR
          if (!isDirectory && name.isNotEmpty()) {
            infos.add(EntryInfo(name, ArchiveEntry.size(entry), "-"))
          }
          Archive.readDataSkip(handle)
        }
        return LibarchiveReader(openSource, infos, encrypted)
      } finally {
        try {
          Archive.readClose(handle)
        } finally {
          Archive.readFree(handle)
        }
      }
    } catch (e: Throwable) {
      if (looksEncrypted(e)) throw EncryptedArchiveException("rar needs a password")
      throw IOException(e.message ?: e.javaClass.simpleName ?: "cannot open rar archive")
    } finally {
      try {
        source.close()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  private fun openChannel(uri: String): FileChannel {
    val pfd =
        reactApplicationContext.contentResolver.openFileDescriptor(Uri.parse(uri), "r")
            ?: throw IOException("cannot open archive")
    return java.io.FileInputStream(pfd.fileDescriptor).channel
  }

  private fun openZip(channel: FileChannel, charset: Charset): ZipFile =
      ZipFile.builder().setSeekableByteChannel(channel).setCharset(charset).get()

  /** `[[entries], encrypted]` for an open ZIP. */
  private fun zipInfos(zip: ZipFile): Pair<List<EntryInfo>, Boolean> {
    var encrypted = false
    val list = ArrayList<EntryInfo>()
    for (entry in zip.entries) {
      if (entry.isDirectory) continue
      if (entry.generalPurposeBit?.usesEncryption() == true) encrypted = true
      list.add(EntryInfo(entry.name, entry.size, entry.crc.toString()))
    }
    return list to encrypted
  }

  /** Heuristic for "this archive wants a password" across the libraries. */
  private fun looksEncrypted(e: Throwable): Boolean {
    val name = e.javaClass.simpleName.lowercase()
    val msg = (e.message ?: "").lowercase()
    return name.contains("password") ||
        msg.contains("password") ||
        msg.contains("encrypt") ||
        msg.contains("crypto") ||
        msg.contains("passphrase")
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private fun isMediaEntry(name: String): Boolean {
    // Tarballs created from "." prefix every path with "./".
    val normalized = name.removePrefix("./").lowercase()
    if (normalized.startsWith("__macosx/")) return false
    if (normalized.substringAfterLast('/').startsWith(".")) return false
    val ext = normalized.substringAfterLast('.', "")
    return MEDIA_EXTENSIONS.contains(ext)
  }

  private fun sanitizeName(name: String): String {
    val base = name.substringAfterLast('/')
    val safe = base.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim()
    return if (safe.isEmpty()) "entry" else safe
  }

  private fun failure(path: String, reason: String) = Arguments.createMap().apply {
    putString("path", path)
    putString("reason", reason)
  }

  private fun errorResult(code: String, message: String) = Arguments.createMap().apply {
    putBoolean("ok", false)
    putString("error", code)
    putString("message", message)
  }

  private fun emitProgress(done: Int, total: Int, name: String) {
    val reactContext = reactApplicationContext
    if (!reactContext.hasActiveReactInstance()) return
    try {
      val payload = Arguments.createMap()
      payload.putInt("done", done)
      payload.putInt("total", total)
      payload.putString("name", name)
      reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_PROGRESS, payload)
    } catch (_: Throwable) {
      // Best-effort only.
    }
  }

  private fun sha256Hex(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
    return bytes.joinToString("") { "%02x".format(it) }
  }

  /** Required by NativeEventEmitter on the JS side. */
  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}
}
