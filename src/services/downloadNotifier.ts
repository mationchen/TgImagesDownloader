import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

/**
 * JS bridge for download notifications (spec §21).
 *
 * The native side runs a foreground service so the JS download queue keeps
 * working after the app is backgrounded (spec §20), and renders progress /
 * completion notifications.
 *
 * Notification permission (Android 13+ POST_NOTIFICATIONS) is requested
 * lazily from this module; it's safe to call on all Android versions.
 */

const native =
  Platform.OS === 'android' ? NativeModules.TelegraphNotifier : undefined;

type NotifierModule = {
  start: (title: string, total: number) => void;
  update: (done: number, total: number) => void;
  finish: (success: number, failed: number, skipped: number) => void;
  stop: () => void;
};

function module(): NotifierModule | undefined {
  return native as NotifierModule | undefined;
}

/** True when notifications are usable on this platform/device. */
export function isNotifierSupported(): boolean {
  return Platform.OS === 'android' && module() != null;
}

/** Android 13+ needs POST_NOTIFICATIONS; older versions grant implicitly. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version < 33) return true;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/**
 * Start the foreground download notification. No-op if the platform is iOS
 * or the native module is unavailable.
 */
export function notifyDownloadStart(title: string, total: number): void {
  const m = module();
  if (!m) return;
  try {
    m.start(title, total);
  } catch {
    // best-effort
  }
}

/** Refresh the running progress notification. */
export function notifyDownloadProgress(done: number, total: number): void {
  const m = module();
  if (!m) return;
  try {
    m.update(done, total);
  } catch {
    // best-effort
  }
}

/** Show the completion summary notification. */
export function notifyDownloadFinished(
  success: number,
  failed: number,
  skipped: number,
): void {
  const m = module();
  if (!m) return;
  try {
    m.finish(success, failed, skipped);
  } catch {
    // best-effort
  }
}

/** Stop the foreground service and clear the notification. */
export function notifyDownloadStop(): void {
  const m = module();
  if (!m) return;
  try {
    m.stop();
  } catch {
    // best-effort
  }
}
