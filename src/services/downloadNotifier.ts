import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

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
  isIgnoringBatteryOptimizations: () => Promise<boolean>;
  requestIgnoreBatteryOptimizations: () => Promise<void>;
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
 * Whether the app is whitelisted from battery optimization / Doze. Without
 * the whitelist a long background batch can still be frozen by the system
 * even with the foreground service running. Non-Android platforms and
 * errors fail open (true) so callers never block on this.
 */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  const m = module();
  if (!m?.isIgnoringBatteryOptimizations) return true;
  try {
    return await m.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

/**
 * Open the system "ignore battery optimizations" dialog for this app
 * (best-effort; some vendors fall back to the whitelist list screen).
 */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  const m = module();
  if (!m?.requestIgnoreBatteryOptimizations) return;
  try {
    await m.requestIgnoreBatteryOptimizations();
  } catch {
    // best-effort: the user can still whitelist manually in system settings
  }
}

/** Native event emitted every couple of seconds while the service runs. */
const EVENT_KEEP_ALIVE = 'TgDownloader:keepAlive';

/**
 * Subscribe to the native keep-alive tick emitted by the download foreground
 * service.
 *
 * Why this exists: on aggressive OEM builds (MIUI/HyperOS, EMUI, ColorOS) the
 * system freezes a backgrounded app's JS thread even though a foreground
 * service and a wake lock are held — so the `setTimeout` chain that drives the
 * download queue stops firing until the app returns to the foreground. Each
 * native event delivery wakes the JS thread, and the queue picks up where it
 * left off. Returns an unsubscribe function; a no-op on iOS/unavailable.
 */
export function subscribeDownloadKeepAlive(onTick: () => void): () => void {
  if (!isNotifierSupported()) return () => undefined;
  try {
    const emitter = new NativeEventEmitter(
      native as ConstructorParameters<typeof NativeEventEmitter>[0],
    );
    const sub = emitter.addListener(EVENT_KEEP_ALIVE, onTick);
    return () => {
      try {
        sub.remove();
      } catch {
        // best-effort
      }
    };
  } catch {
    return () => undefined;
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
    // The native method carries a Promise param, so the RN bridge actually
    // returns a Promise even though the typed surface says void. Swallow
    // rejections (some OEMs refuse background foreground-service starts) to
    // avoid unhandled-rejection noise.
    Promise.resolve(m.start(title, total)).catch(() => undefined);
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
