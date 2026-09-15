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
};

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
