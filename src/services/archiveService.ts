import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * Bridge for local archive import ("解压压缩包").
 *
 * The native side (Android) opens a picked `content://` archive, reports a
 * content fingerprint plus its image entries, and streams requested entries
 * into the app cache. Saving to the gallery then reuses the normal
 * `TelegraphDownloader.saveImageToMediaStore` path, so naming/subfolder rules
 * and the history ledger behave exactly like a web download.
 */

const native =
  Platform.OS === 'android' ? NativeModules.TelegraphArchive : undefined;

export type ArchiveChild = {
  name: string;
  uri: string;
  isDirectory: boolean;
  /** Bytes (0 for directories / unknown). */
  size: number;
  /** Epoch ms, 0 when unknown. */
  modified: number;
};

export type ArchiveImageEntry = {
  /** Path inside the archive (used as the ledger key suffix). */
  path: string;
  /** Basename, for the saved file name. */
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
};

export type ArchiveInspection = {
  ok: boolean;
  /** Content identity; stable across renames (see the native KDoc). */
  fingerprint?: string;
  totalEntries?: number;
  /** Image entries only; directories/metadata/non-images are dropped. */
  images?: ArchiveImageEntry[];
  /** True when any entry is password-protected (not supported). */
  encrypted?: boolean;
  /** Machine-readable failure: TOO_LARGE | TOO_MANY_ENTRIES | UNREADABLE. */
  error?: string;
  message?: string;
};

export type ArchiveExtractedItem = {
  path: string;
  tmpPath: string;
  bytes: number;
};

export type ArchiveExtractResult = {
  items: ArchiveExtractedItem[];
  failed: { path: string; reason: string }[];
  cancelled: boolean;
};

type ArchiveModule = {
  pickTree: () => Promise<{ uri: string; name: string } | null>;
  pickArchives: () => Promise<PickedArchiveFile[] | null>;
  listChildren: (treeUri: string) => Promise<ArchiveChild[]>;
  inspect: (uri: string) => Promise<ArchiveInspection>;
  extract: (uri: string, entryPaths: string[]) => Promise<ArchiveExtractResult>;
  cancelExtract: () => void;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

function module(): ArchiveModule | undefined {
  return native as ArchiveModule | undefined;
}

/** Whether local archive import is usable on this platform/device. */
export function isArchiveSupported(): boolean {
  return Platform.OS === 'android' && module() != null;
}

/**
 * Extensions we accept from the browser. `.cbz`/`.cbr` are plain zip/rar
 * comic archives; `.tgz`/`.tar.gz` are gzipped tarballs.
 */
export const ARCHIVE_EXTENSIONS = [
  'zip',
  'rar',
  '7z',
  '7zip',
  'cbz',
  'cbr',
  'tar',
  'tgz',
] as const;

/** Extensions made of two dotted parts (checked before the last-dot lookup). */
const COMPOUND_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz'] as const;

/** True when `name` looks like an archive we can open. */
export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (COMPOUND_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true;
  const ext = lower.split('.').pop() ?? '';
  return (ARCHIVE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Open the system directory picker (the in-app browser's root). */
export async function pickArchiveTree(): Promise<{
  uri: string;
  name: string;
} | null> {
  const m = module();
  if (!m) return null;
  return m.pickTree();
}

/** A file returned by the system picker. */
export type PickedArchiveFile = {
  uri: string;
  name: string;
  /** Bytes, 0 when the provider does not report a size. */
  size: number;
};

/** Minimal `{uri, name}` pair queued for extraction. */
export type PickedArchive = { uri: string; name: string };

/**
 * Open the system file picker for archives (single or multi selection).
 *
 * Resolves `null` when the user cancelled. The picker is pre-filtered to
 * archive MIME types, but OEM pickers may ignore that — callers must still
 * validate the names with {@link isArchiveName}.
 */
export async function pickArchiveFiles(): Promise<PickedArchiveFile[] | null> {
  const m = module();
  if (!m) return null;
  try {
    return await m.pickArchives();
  } catch {
    return null;
  }
}

/** List one folder of the picked tree (unfiltered; the caller filters). */
export async function listArchiveChildren(
  treeUri: string,
): Promise<ArchiveChild[]> {
  const m = module();
  if (!m) return [];
  return m.listChildren(treeUri);
}

/** Fingerprint + image entries of an archive. Never rejects. */
export async function inspectArchive(uri: string): Promise<ArchiveInspection> {
  const m = module();
  if (!m) return { ok: false, error: 'UNSUPPORTED', message: 'not available' };
  try {
    const result = await m.inspect(uri);
    return result ?? { ok: false, error: 'UNREADABLE' };
  } catch (e) {
    return {
      ok: false,
      error: 'UNREADABLE',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Stream the given entries out of the archive into the app cache. */
export async function extractArchiveEntries(
  uri: string,
  entryPaths: string[],
): Promise<ArchiveExtractResult> {
  const m = module();
  if (!m) return { items: [], failed: [], cancelled: false };
  try {
    return await m.extract(uri, entryPaths);
  } catch {
    return { items: [], failed: [], cancelled: false };
  }
}

/** Ask a running extraction to stop after the current entry. */
export function cancelArchiveExtract(): void {
  try {
    module()?.cancelExtract();
  } catch {
    // best-effort
  }
}

/** `{done, total, name}` ticks emitted while extracting. */
export type ArchiveProgress = { done: number; total: number; name: string };

/** Subscribe to extraction progress. Returns an unsubscribe function. */
export function subscribeArchiveProgress(
  listener: (progress: ArchiveProgress) => void,
): () => void {
  const m = module();
  if (!m) return () => undefined;
  try {
    const emitter = new NativeEventEmitter(
      native as ConstructorParameters<typeof NativeEventEmitter>[0],
    );
    const sub = emitter.addListener('TgArchive:progress', (payload: unknown) =>
      listener(payload as ArchiveProgress),
    );
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
