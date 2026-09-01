import {NativeModules} from 'react-native';

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
      ): Promise<SaveResult>;
    }
  | undefined;

export function isDownloaderAvailable(): boolean {
  return TelegraphDownloader != null;
}