import { NativeModules } from 'react-native';

/** Static app metadata read from the OS (Android PackageManager / iOS NSBundle). */
export type AppInfo = {
  /** Application label / display name. */
  appName: string;
  /** Bundle id (iOS) / package name (Android). */
  packageName: string;
  /** Marketing version: Android versionName / iOS CFBundleShortVersionString. */
  version: string;
  /** Build number: Android versionCode / iOS CFBundleVersion. */
  buildNumber: string;
};

const EMPTY: AppInfo = {
  appName: '',
  packageName: '',
  version: '',
  buildNumber: '',
};

type AppInfoNativeModule = {
  getAppInfo?: () => Promise<Partial<AppInfo> | null | undefined>;
  getNetworkType?: () => Promise<string | null | undefined>;
};

/** Transport carrying the user's internet traffic. */
export type NetworkType = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

/** The native `AppInfo` module, or undefined when it isn't linked. */
function nativeModule(): AppInfoNativeModule | undefined {
  return (NativeModules as Record<string, unknown>).AppInfo as
    | AppInfoNativeModule
    | undefined;
}

/** Coerce a native payload into a fully-populated {@link AppInfo}. */
export function normalizeAppInfo(
  raw: Partial<AppInfo> | null | undefined,
): AppInfo {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    appName: str(raw?.appName),
    packageName: str(raw?.packageName),
    version: str(raw?.version),
    buildNumber: str(raw?.buildNumber),
  };
}

export function isAppInfoAvailable(): boolean {
  return typeof nativeModule()?.getAppInfo === 'function';
}

/**
 * Read the app's name/version from the native side. Resolves to empty strings
 * (rather than throwing) when the module isn't linked, so the 关于 section
 * still renders on a platform that hasn't been rebuilt yet.
 */
export async function getAppInfo(): Promise<AppInfo> {
  const mod = nativeModule();
  if (typeof mod?.getAppInfo !== 'function') return { ...EMPTY };
  try {
    return normalizeAppInfo(await mod.getAppInfo());
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Report the transport carrying the user's internet traffic.
 *
 * Resolves 'unknown' when the native module isn't linked (e.g. a platform that
 * hasn't been rebuilt yet) or the query fails, so callers can treat it as
 * "cannot tell" and never block a download on it.
 */
export async function getNetworkType(): Promise<NetworkType> {
  const mod = nativeModule();
  if (typeof mod?.getNetworkType !== 'function') return 'unknown';
  try {
    const raw = await mod.getNetworkType();
    switch (raw) {
      case 'wifi':
      case 'cellular':
      case 'ethernet':
      case 'none':
        return raw;
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}
