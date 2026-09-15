import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type SaveResult = {
  /** content:// URI on Android Q+, file:// URI on Android < Q. */
  uri: string;
  /** Bytes actually written. */
  bytes: number;
  /** Resolved MIME type (image/*). */
  mimeType: string;
  /** The filename that was used (after sanitization). */
  filename: string;
  /** The subfolder that was used (after sanitization). */
  subfolder: string;
  /** True when running on Android < 10 (legacy File API path). */
  legacy: boolean;
};

export type SaveError = {
  code: string;
  message: string;
};

export type TreePickedEvent = {
  uri: string;
};

/** Result of {@link TelegraphDownloader.pickTextFile}. */
export type PickedTextFile = {
  /** The content:// URI returned by the system SAF picker. */
  uri: string;
  /** Display name reported by the picker (e.g. `urls.txt`). */
  name: string;
  /** UTF-8 text content with any leading BOM stripped. */
  content: string;
};

/** Result of {@link TelegraphDownloader.migrateImagesToBase}. */
export type MigrateResult = {
  /** Number of media rows moved into their app base folder. */
  moved: number;
  /** Empty subfolders successfully deleted afterwards. */
  dirsDeleted: number;
  /** Subfolders still present (deletion blocked by the OS, typically AAC). */
  dirsRemaining: number;
  /** Non-fatal per-item failures encountered while moving. */
  errors: number;
};

/**
 * Lightweight wrapper around the native TelegraphDownloader module.
 *
 * The native side handles MediaStore insert (RELATIVE_PATH =
 * "Pictures/TelegraphDownloader/<subfolder>/") on Android 10+, and the
 * legacy File API on Android 7-9. No permissions need to be requested
 * up-front because we never touch shared external storage directly.
 */
export const TelegraphDownloader = NativeModules.TelegraphDownloader as
  | {
      saveImageToMediaStore(
        localFilePath: string,
        subfolder: string,
        filename: string,
        customTreeUri?: string,
        storageType?: string,
      ): Promise<SaveResult>;
      listGalleryImages?(relativePathPrefix: string): Promise<string[]>;
      /**
       * Move every image currently in a per-article subfolder of the app's
       * MediaStore base folder up into the base folder itself, then
       * best-effort delete the now-empty subfolders. Preserves each media
       * row's `_ID`, so stored content:// URIs remain valid.
       */
      migrateImagesToBase?(): Promise<MigrateResult>;
      pickSaveDirectory?(): Promise<boolean>;
      persistPickedTreeUri?(uri: string): Promise<boolean>;
      /**
       * Open the system SAF text-file picker. Resolves with the picked file's
       * `{uri, name, content}` on success, or `null` if the user cancelled.
       */
      pickTextFile?(): Promise<PickedTextFile | null>;
    }
  | undefined;

export function isDownloaderAvailable(): boolean {
  return TelegraphDownloader != null;
}

const nativeEmitter =
  Platform.OS === 'android' && TelegraphDownloader != null
    ? new NativeEventEmitter(NativeModules.TelegraphDownloader as never)
    : null;

/**
 * Subscribe to the native "user picked a directory tree" event. The native
 * module emits `TelegraphDownloader:treePicked` after the system SAF picker
 * returns; the JS side persists the URI in settings and updates the UI.
 */
export function subscribeTreePicked(
  listener: (event: TreePickedEvent) => void,
): () => void {
  if (!nativeEmitter) return () => undefined;
  const sub = nativeEmitter.addListener('TelegraphDownloader:treePicked', ((
    payload: TreePickedEvent,
  ) => listener(payload)) as never);
  return () => sub.remove();
}
