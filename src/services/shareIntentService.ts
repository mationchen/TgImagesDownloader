import {
  NativeEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';

/**
 * Bridge for Android "Share -> Telegraph Downloader" intents (spec §7 / §33
 * Phase 7). RN's `Linking` only handles ACTION_VIEW / URL schemes, not
 * ACTION_SEND with text/plain, so this wraps our native ShareIntentModule.
 *
 * The native module is Android-only; on iOS we return no-ops so consumers can
 * call these functions unconditionally (AGENTS.md §3 cross-platform safety).
 */

export interface SharePayload {
  url: string | null;
  hasUrl: boolean;
}

const native =
  Platform.OS === 'android'
    ? NativeModules.TelegraphShare
    : undefined;

type ShareModule = {
  getInitialShare: () => Promise<SharePayload>;
  consumePendingShare: () => Promise<SharePayload>;
  addListener: (name: string) => void;
  removeListeners: (count: number) => void;
};

function isModuleAvailable(): boolean {
  return Platform.OS === 'android' && native != null;
}

/** Whether the current platform can receive shares. */
export function isShareSupported(): boolean {
  return isModuleAvailable();
}

/**
 * Read a URL shared into the app on a cold start (app not already running).
 */
export async function getInitialShare(): Promise<SharePayload> {
  if (!isModuleAvailable()) {
    return {url: null, hasUrl: false};
  }
  try {
    return await (native as unknown as ShareModule).getInitialShare();
  } catch {
    return {url: null, hasUrl: false};
  }
}

/**
 * Drain any buffered share that arrived while the JS side wasn't listening
 * (e.g. onNewIntent fired before HomeScreen subscribed).
 */
export async function consumePendingShare(): Promise<SharePayload> {
  if (!isModuleAvailable()) {
    return {url: null, hasUrl: false};
  }
  try {
    return await (native as unknown as ShareModule).consumePendingShare();
  } catch {
    return {url: null, hasUrl: false};
  }
}

export type ShareListener = (payload: SharePayload) => void;

let emitter: NativeEventEmitter | null = null;
let sharedListener: {remove: () => void} | null = null;

function ensureEmitter(): NativeEventEmitter {
  if (!emitter) {
    // The native module exposes addListener/removeListeners (required for
    // NativeEventEmitter); we cast the raw module shape so TS is satisfied.
    emitter = new NativeEventEmitter(native as unknown as {
      addListener: (eventName: string) => unknown;
      removeListeners: (count: number) => void;
    });
  }
  return emitter;
}

/**
 * Subscribe to live share events. Returns an unsubscribe function.
 * On iOS (unsupported) it returns a no-op unsubscribe.
 */
export function subscribeToShares(listener: ShareListener): () => void {
  if (!isModuleAvailable()) {
    return () => undefined;
  }
  const e = ensureEmitter();
  // NativeEventEmitter's addListener expects `(...args: Object[]) => unknown`;
  // the native side emits a single WritableMap, which we coerce to our
  // typed SharePayload shape. The `as never` widens our payload type so it
  // satisfies the emitter's broad signature without losing readability.
  const sub = e.addListener(
    'TelegraphShare',
    ((payload: SharePayload) => listener(payload)) as never,
  );
  sharedListener = sub;
  return () => {
    sub.remove();
    sharedListener = null;
  };
}

/** Test-only teardown helper. */
export function _teardown(): void {
  sharedListener?.remove();
  sharedListener = null;
  emitter = null;
}