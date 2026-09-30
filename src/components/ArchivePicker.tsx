import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t, useI18n } from '../i18n';
import { useThemedStyles, type ThemeColors } from '../theme';
import {
  getSetting,
  listHistoryByUrls,
  setSetting,
} from '../services/historyService';
import { archiveHistoryUrl } from '../services/archiveImport';
import {
  inspectArchive,
  isArchiveName,
  isArchiveSupported,
  listArchiveChildren,
  pickArchiveFiles,
  pickArchiveTree,
  type ArchiveChild,
  type PickedArchive,
} from '../services/archiveService';

/** Persisted SAF tree the browser opens into next time. */
const TREE_URI_KEY = 'archive_browse_tree_uri';
const TREE_NAME_KEY = 'archive_browse_tree_name';
/** Persisted sort choice, so the list keeps the user's preference. */
const SORT_KEY = 'archive_sort_key';
const SORT_ASC_KEY = 'archive_sort_asc';

type SortKey = 'name' | 'time';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Called with the selection; the caller queues them for extraction. */
  onPick: (archives: PickedArchive[]) => void;
};

/**
 * In-app archive browser — the only way to show *only* archives.
 *
 * A system picker can filter by MIME type, but MIUI's file manager ignores that
 * and lists every file (verified on device), while some Android versions have
 * no `.rar` mapping and would hide rar files. Listing the folder ourselves and
 * filtering by extension sidesteps both.
 *
 * The folder is granted once via SAF and remembered, so on every later open the
 * user lands straight in the filtered list. Archives that were imported before
 * are badged (matched by content fingerprint, so a renamed copy still counts)
 * and can be hidden with the filter toggle.
 */
export const ArchivePicker: React.FC<Props> = ({
  visible,
  onClose,
  onPick,
}) => {
  // Subscribe so labels re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);

  // Root of the browse tree (persisted between sessions).
  const [rootUri, setRootUri] = useState<string | null>(null);
  const [rootName, setRootName] = useState('');
  // Drill-down stack, excluding the root. Empty = showing the root.
  const [stack, setStack] = useState<{ uri: string; name: string }[]>([]);
  const [children, setChildren] = useState<ArchiveChild[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Map<string, PickedArchive>>(
    new Map(),
  );
  // Sorting (persisted) + "hide already imported" filter.
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [hideImported, setHideImported] = useState(false);
  const [showSortSheet, setShowSortSheet] = useState(false);
  // Archives already imported, keyed by their picked URI.
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);

  const current = stack.length > 0 ? stack[stack.length - 1] : null;
  const currentUri = current?.uri ?? rootUri;

  const loadDir = useCallback(async (uri: string) => {
    setLoading(true);
    setError(false);
    try {
      setChildren(await listArchiveChildren(uri));
    } catch {
      setChildren([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // On open: restore the remembered folder + sort choice.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setStack([]);
    setSelected(new Map());
    setImported(new Set());
    (async () => {
      try {
        const [uri, name, savedKey, savedAsc] = await Promise.all([
          getSetting(TREE_URI_KEY),
          getSetting(TREE_NAME_KEY),
          getSetting(SORT_KEY),
          getSetting(SORT_ASC_KEY),
        ]);
        if (cancelled) return;
        if (savedKey === 'name' || savedKey === 'time') setSortKey(savedKey);
        if (savedAsc != null) setSortAsc(savedAsc !== '0');
        if (!uri) {
          setRootUri(null);
          setRootName('');
          setChildren([]);
          return;
        }
        setRootUri(uri);
        setRootName(name ?? '');
        await loadDir(uri);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, loadDir]);

  /**
   * Resolve which archives were already imported. The history key is a content
   * fingerprint, so this needs to read each archive's directory — cheap
   * (milliseconds) and done in the background, updating rows as results land.
   */
  useEffect(() => {
    const archives = children.filter(
      c => !c.isDirectory && isArchiveName(c.name),
    );
    if (archives.length === 0) {
      setImported(new Set());
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    (async () => {
      const found = new Set<string>();
      for (const child of archives) {
        if (cancelled) return;
        try {
          const info = await inspectArchive(child.uri);
          if (info.ok && info.fingerprint) {
            const url = archiveHistoryUrl(info.fingerprint);
            const row = (await listHistoryByUrls([url])).get(url);
            if (row) found.add(child.uri);
          }
        } catch {
          // Unreadable/unsupported archives simply don't get the badge.
        }
        if (cancelled) return;
        setImported(new Set(found));
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [children]);

  const onChooseFolder = useCallback(async () => {
    try {
      const picked = await pickArchiveTree();
      if (!picked) return; // user cancelled
      setRootUri(picked.uri);
      setRootName(picked.name);
      setStack([]);
      setSelected(new Map());
      await Promise.all([
        setSetting(TREE_URI_KEY, picked.uri),
        setSetting(TREE_NAME_KEY, picked.name),
      ]);
      await loadDir(picked.uri);
    } catch {
      setError(true);
    }
  }, [loadDir]);

  /** Folders first, then archives (or reverse for descending). */
  const rows = useMemo(() => {
    const list = children.filter(
      c =>
        c.isDirectory ||
        (isArchiveName(c.name) && !(hideImported && imported.has(c.uri))),
    );
    const dir = sortAsc ? 1 : -1;
    return list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sortKey === 'time') return (a.modified - b.modified) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
  }, [children, sortKey, sortAsc, hideImported, imported]);

  const toggle = useCallback((child: ArchiveChild) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(child.uri)) next.delete(child.uri);
      else next.set(child.uri, { uri: child.uri, name: child.name });
      return next;
    });
  }, []);

  const enterFolder = useCallback(
    async (child: ArchiveChild) => {
      setStack(prev => [...prev, { uri: child.uri, name: child.name }]);
      await loadDir(child.uri);
    },
    [loadDir],
  );

  const goUp = useCallback(async () => {
    const next = stack.slice(0, -1);
    setStack(next);
    const uri = next.length > 0 ? next[next.length - 1].uri : rootUri;
    if (uri) await loadDir(uri);
  }, [stack, rootUri, loadDir]);

  const chooseSort = useCallback((key: SortKey, asc: boolean) => {
    setSortKey(key);
    setSortAsc(asc);
    setShowSortSheet(false);
    setSetting(SORT_KEY, key).catch(() => undefined);
    setSetting(SORT_ASC_KEY, asc ? '1' : '0').catch(() => undefined);
  }, []);

  const confirm = useCallback(() => {
    onPick(Array.from(selected.values()));
    setSelected(new Map());
    onClose();
  }, [onPick, onClose, selected]);

  /**
   * Fallback for users who would rather not grant a folder: the system file
   * picker allows multi-selection but cannot reliably filter by type (MIUI
   * lists everything), so anything that isn't an archive is reported back.
   */
  const onSystemPick = useCallback(async () => {
    const picked = await pickArchiveFiles();
    if (!picked || picked.length === 0) return; // cancelled
    const archives = picked.filter(p => isArchiveName(p.name));
    const rejected = picked.filter(p => !isArchiveName(p.name));
    if (rejected.length > 0) {
      Alert.alert(
        t('archive.notArchiveTitle'),
        t('archive.notArchiveBody', {
          count: rejected.length,
          names: rejected
            .slice(0, 3)
            .map(r => r.name)
            .join('、'),
        }),
      );
    }
    if (archives.length > 0) {
      onPick(archives.map(a => ({ uri: a.uri, name: a.name })));
      onClose();
    }
  }, [onPick, onClose]);

  const selectedCount = selected.size;

  const formatSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const formatTime = (ms: number): string => {
    if (!ms || ms <= 0) return '';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
      d.getHours(),
    )}:${p(d.getMinutes())}`;
  };

  if (!visible) return null;

  const canBrowse = !!currentUri;

  const sortOptions: { key: SortKey; asc: boolean; label: string }[] = [
    { key: 'name', asc: true, label: t('archive.sortNameAsc') },
    { key: 'name', asc: false, label: t('archive.sortNameDesc') },
    { key: 'time', asc: false, label: t('archive.sortTimeDesc') },
    { key: 'time', asc: true, label: t('archive.sortTimeAsc') },
  ];

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView
        style={styles.safe}
        edges={['top', 'left', 'right', 'bottom']}
      >
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={({ pressed }) => [
              styles.headerBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.headerBtnText}>{t('common.cancel')}</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{t('archive.pickerTitle')}</Text>
          <Pressable
            onPress={onChooseFolder}
            hitSlop={8}
            style={({ pressed }) => [
              styles.headerBtn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.headerBtnText}>
              {canBrowse
                ? t('archive.changeFolder')
                : t('archive.chooseFolder')}
            </Text>
          </Pressable>
        </View>

        {!canBrowse ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>
              {t('archive.pickFolderTitle')}
            </Text>
            <Text style={styles.emptyHint}>{t('archive.pickFolderHint')}</Text>
            <Pressable
              onPress={onChooseFolder}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>
                {t('archive.chooseFolder')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                onSystemPick().catch(() => undefined);
              }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.linkBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.linkBtnText}>
                {t('archive.systemPicker')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.pathRow}>
              <Pressable
                onPress={goUp}
                disabled={stack.length === 0}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.upBtn,
                  stack.length === 0 && styles.upBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.upBtnText}>↑</Text>
              </Pressable>
              <Text style={styles.pathText} numberOfLines={1}>
                {stack.length > 0
                  ? stack[stack.length - 1].name
                  : rootName || t('archive.rootLabel')}
              </Text>
              {checking ? (
                <ActivityIndicator size="small" style={styles.checking} />
              ) : null}
              <Pressable
                onPress={() => setShowSortSheet(true)}
                accessibilityRole="button"
                accessibilityLabel={t('archive.sort')}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.toolBtn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.toolBtnText}>⇅</Text>
              </Pressable>
              <Pressable
                onPress={() => setHideImported(v => !v)}
                accessibilityRole="button"
                accessibilityLabel={t('archive.showImported')}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.toolBtn,
                  hideImported && styles.toolBtnActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.toolBtnText,
                    hideImported && styles.toolBtnTextActive,
                  ]}
                >
                  {hideImported ? '☑' : '☐'}
                </Text>
              </Pressable>
            </View>

            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator />
              </View>
            ) : (
              <FlatList
                data={rows}
                keyExtractor={item => item.uri}
                ListEmptyComponent={
                  <View style={styles.emptyBlock}>
                    <Text style={styles.emptyHint}>
                      {error ? t('archive.listError') : t('archive.noArchives')}
                    </Text>
                  </View>
                }
                renderItem={({ item }) => {
                  const isChecked = selected.has(item.uri);
                  const wasImported = imported.has(item.uri);
                  return (
                    <Pressable
                      onPress={() =>
                        item.isDirectory ? enterFolder(item) : toggle(item)
                      }
                      style={({ pressed }) => [
                        styles.row,
                        isChecked && styles.rowChecked,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.rowIcon}>
                        {item.isDirectory ? '📁' : isChecked ? '☑' : '☐'}
                      </Text>
                      <View style={styles.rowMain}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <View style={styles.rowMetaRow}>
                          {!item.isDirectory ? (
                            <Text style={styles.rowMeta}>
                              {formatSize(item.size)}
                              {formatTime(item.modified)
                                ? ` · ${formatTime(item.modified)}`
                                : ''}
                            </Text>
                          ) : null}
                          {wasImported ? (
                            <Text style={styles.importedBadge}>
                              {t('archive.importedBadge')}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                }}
                contentContainerStyle={styles.list}
              />
            )}

            <View style={styles.footer}>
              <Text style={styles.footerText}>
                {t('archive.selectedCount', { count: selectedCount })}
              </Text>
              <Pressable
                onPress={confirm}
                disabled={selectedCount === 0}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  selectedCount === 0 && styles.primaryBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryBtnText}>
                  {t('archive.startExtract')}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {!isArchiveSupported() ? (
          <Text style={styles.unsupported}>{t('archive.unsupported')}</Text>
        ) : null}

        {/* Sort options */}
        <Modal
          visible={showSortSheet}
          transparent
          animationType="fade"
          onRequestClose={() => setShowSortSheet(false)}
        >
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setShowSortSheet(false)}
          >
            <Pressable style={styles.sheet} onPress={() => undefined}>
              <Text style={styles.sheetTitle}>{t('archive.sort')}</Text>
              {sortOptions.map(option => {
                const active = option.key === sortKey && option.asc === sortAsc;
                return (
                  <Pressable
                    key={`${option.key}-${option.asc}`}
                    onPress={() => chooseSort(option.key, option.asc)}
                    style={({ pressed }) => [
                      styles.sheetOption,
                      active && styles.sheetOptionActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.sheetOptionText,
                        active && styles.sheetOptionTextActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                    {active ? <Text style={styles.sheetCheck}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </Pressable>
          </Pressable>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      height: 48,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerBtn: { paddingHorizontal: 6, paddingVertical: 4 },
    headerBtnText: { fontSize: 14, color: c.primary, fontWeight: '600' },
    headerTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    pathRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
    },
    upBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    upBtnDisabled: { opacity: 0.4 },
    upBtnText: { fontSize: 16, color: c.textSecondary },
    pathText: { flex: 1, fontSize: 13, color: c.textSecondary },
    checking: { marginRight: 2 },
    /** Sort / filter icon buttons in the path row. */
    toolBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toolBtnActive: { backgroundColor: c.primarySoft },
    toolBtnText: { fontSize: 15, color: c.textSecondary },
    toolBtnTextActive: { color: c.primarySoftText, fontWeight: '700' },
    list: { paddingBottom: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 10,
    },
    rowChecked: { backgroundColor: c.primarySoft },
    rowIcon: { fontSize: 16 },
    rowMain: { flex: 1 },
    rowName: { fontSize: 15, color: c.textPrimary },
    rowMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    },
    rowMeta: { fontSize: 12, color: c.textSecondary },
    importedBadge: {
      fontSize: 11,
      color: c.primarySoftText,
      backgroundColor: c.primarySoft,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyBlock: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 10,
    },
    emptyTitle: { fontSize: 16, fontWeight: '600', color: c.textPrimary },
    emptyHint: {
      fontSize: 13,
      color: c.textSecondary,
      textAlign: 'center',
      lineHeight: 19,
    },
    primaryBtn: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.primary,
      alignItems: 'center',
    },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { fontSize: 14, color: c.textOnPrimary, fontWeight: '600' },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      gap: 12,
    },
    footerText: { fontSize: 13, color: c.textSecondary },
    unsupported: {
      padding: 12,
      fontSize: 12,
      color: c.textHint,
      textAlign: 'center',
    },
    pressed: { opacity: 0.6 },
    linkBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    linkBtnText: {
      fontSize: 13,
      color: c.primary,
      textDecorationLine: 'underline',
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: c.backdrop,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 12,
      paddingBottom: 20,
      paddingHorizontal: 8,
    },
    sheetTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
      paddingHorizontal: 8,
      marginBottom: 6,
    },
    sheetOption: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderRadius: 10,
    },
    sheetOptionActive: { backgroundColor: c.primarySoft },
    sheetOptionText: { fontSize: 15, color: c.textPrimary },
    sheetOptionTextActive: { color: c.primarySoftText, fontWeight: '600' },
    sheetCheck: {
      fontSize: 15,
      color: c.primarySoftText,
      fontWeight: '700',
    },
  });
