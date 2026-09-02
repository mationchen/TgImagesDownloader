import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  computeBaseRelativePath,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings,
  type NamingRule,
  type StorageType,
  type SubfolderTemplate,
} from '../services/settingsService';
import {
  isDownloaderAvailable,
  subscribeTreePicked,
  TelegraphDownloader,
} from '../services/nativeDownloader';
import {t} from '../i18n';

export const SettingsScreen: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await loadSettings();
      if (!cancelled) {
        setSettings(s);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh settings when the user finishes picking a folder tree (native
  // event -> we keep customTreeUri fresh).
  useEffect(() => {
    const unsub = subscribeTreePicked(payload => {
      setSettings(prev => ({...prev, customTreeUri: payload.uri}));
    });
    return () => unsub();
  }, []);

  const persist = useCallback(async (next: AppSettings) => {
    setSettings(next);
    setSaving(true);
    try {
      await saveSettings(next);
    } finally {
      setSaving(false);
    }
  }, []);

  const setTemplate = useCallback(
    (v: SubfolderTemplate) => persist({...settings, subfolderTemplate: v}),
    [persist, settings],
  );
  const setCustom = useCallback(
    (v: string) => persist({...settings, subfolderCustom: v}),
    [persist, settings],
  );
  const setNaming = useCallback(
    (v: NamingRule) => persist({...settings, namingRule: v}),
    [persist, settings],
  );
  const setAutoFill = useCallback(
    (v: boolean) => persist({...settings, autoFillClipboard: v}),
    [persist, settings],
  );
  const setStorage = useCallback(
    (v: StorageType) => persist({...settings, storageType: v}),
    [persist, settings],
  );

  const pickCustomFolder = useCallback(async () => {
    if (Platform.OS !== 'android') {
      Alert.alert(t('settings.unsupported.title'), t('settings.unsupported.body'));
      return;
    }
    if (!isDownloaderAvailable() || !TelegraphDownloader?.pickSaveDirectory) {
      Alert.alert(t('settings.unsupported.title'), t('settings.unsupported.body'));
      return;
    }
    try {
      await TelegraphDownloader.pickSaveDirectory();
      // Native side will fire TelegraphDownloader:treePicked on success; the
      // useEffect listener above updates the UI.
    } catch (err) {
      Alert.alert(
        t('settings.unsupported.title'),
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  const clearCustomFolder = useCallback(
    () => persist({...settings, customTreeUri: '', storageType: 'pictures'}),
    [persist, settings],
  );

  const currentSavePath = computeBaseRelativePath(settings);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('settings.title')}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Section title={t('settings.subfolder.title')}>
          <RadioRow
            label={t('settings.subfolder.titleLabel')}
            hint={t('settings.subfolder.titleHint')}
            selected={settings.subfolderTemplate === 'title'}
            onSelect={() => setTemplate('title')}
          />
          <RadioRow
            label={t('settings.subfolder.domainLabel')}
            hint={t('settings.subfolder.domainHint')}
            selected={settings.subfolderTemplate === 'domain'}
            onSelect={() => setTemplate('domain')}
          />
          <RadioRow
            label={t('settings.subfolder.customLabel')}
            hint={t('settings.subfolder.customHint')}
            selected={settings.subfolderTemplate === 'custom'}
            onSelect={() => setTemplate('custom')}
          />
          {settings.subfolderTemplate === 'custom' ? (
            <TextInput
              style={styles.input}
              value={settings.subfolderCustom}
              onChangeText={setCustom}
              placeholder={t('settings.subfolder.customPlaceholder')}
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={60}
            />
          ) : null}
        </Section>

        <Section title={t('settings.naming.title')}>
          <RadioRow
            label={t('settings.naming.dateIndexLabel')}
            hint={t('settings.naming.dateIndexHint')}
            selected={settings.namingRule === 'date_index'}
            onSelect={() => setNaming('date_index')}
          />
          <RadioRow
            label={t('settings.naming.titleLabel')}
            hint={t('settings.naming.titleHint')}
            selected={settings.namingRule === 'title'}
            onSelect={() => setNaming('title')}
          />
          <RadioRow
            label={t('settings.naming.originalLabel')}
            hint={t('settings.naming.originalHint')}
            selected={settings.namingRule === 'original'}
            onSelect={() => setNaming('original')}
          />
        </Section>

        <Section title={t('settings.storage.title')}>
          <Text style={styles.pathPreview}>
            {t('settings.storage.current', {path: currentSavePath})}
          </Text>
          <RadioRow
            label={t('settings.storage.picturesLabel')}
            hint={t('settings.storage.picturesHint')}
            selected={settings.storageType === 'pictures'}
            onSelect={() => setStorage('pictures')}
          />
          <RadioRow
            label={t('settings.storage.downloadsLabel')}
            hint={t('settings.storage.downloadsHint')}
            selected={settings.storageType === 'downloads'}
            onSelect={() => setStorage('downloads')}
          />
          <RadioRow
            label={t('settings.storage.customLabel')}
            hint={t('settings.storage.customHint')}
            selected={settings.storageType === 'custom'}
            onSelect={() => setStorage('custom')}
          />
          {settings.storageType === 'custom' ? (
            <View style={styles.folderRow}>
              <Pressable style={styles.folderBtn} onPress={pickCustomFolder}>
                <Text style={styles.folderBtnText}>
                  {settings.customTreeUri
                    ? t('settings.storage.changeFolder')
                    : t('settings.storage.pickFolder')}
                </Text>
              </Pressable>
              {settings.customTreeUri ? (
                <Pressable style={styles.folderClear} onPress={clearCustomFolder}>
                  <Text style={styles.folderClearText}>
                    {t('settings.storage.clearFolder')}
                  </Text>
                </Pressable>
              ) : null}
              {settings.customTreeUri ? (
                <Text style={styles.uriPreview} numberOfLines={1}>
                  {settings.customTreeUri}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Section>

        <Section title={t('settings.input.title')}>
          <View style={styles.switchRow}>
            <View style={styles.rowMain}>
              <Text style={styles.rowLabel}>
                {t('settings.input.autoFillLabel')}
              </Text>
              <Text style={styles.rowHint}>
                {t('settings.input.autoFillHint')}
              </Text>
            </View>
            <Switch
              value={settings.autoFillClipboard}
              onValueChange={setAutoFill}
              trackColor={{false: '#ccc', true: '#1976d2'}}
            />
          </View>
        </Section>

        <View style={styles.statusRow}>
          <Text style={styles.statusText}>
            {loaded
              ? saving
                ? t('settings.saving')
                : t('settings.saved')
              : t('common.loading')}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const Section: React.FC<{title: string; children: React.ReactNode}> = ({
  title,
  children,
}) => (
  <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionBody}>{children}</View>
  </View>
);

const RadioRow: React.FC<{
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
}> = ({label, hint, selected, onSelect}) => (
  <Pressable
    onPress={onSelect}
    style={({pressed}) => [styles.row, pressed && styles.rowPressed]}>
    <View style={styles.rowMain}>
      <Text style={styles.rowLabel}>{label}</Text>
      {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
    </View>
    <View
      style={[
        styles.radio,
        selected ? styles.radioSelected : styles.radioUnselected,
      ]}>
      {selected ? <View style={styles.radioInner} /> : null}
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fff'},
  header: {paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8},
  title: {fontSize: 22, fontWeight: '700', color: '#111'},
  body: {paddingHorizontal: 16, paddingBottom: 32},
  section: {marginTop: 16},
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#555',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionBody: {
    backgroundColor: '#f7f8fa',
    borderRadius: 10,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowPressed: {backgroundColor: '#eef0f3'},
  rowMain: {flex: 1, paddingRight: 12},
  rowLabel: {fontSize: 15, color: '#111', fontWeight: '500'},
  rowHint: {marginTop: 2, fontSize: 12, color: '#666'},
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {borderColor: '#1976d2'},
  radioUnselected: {borderColor: '#bbb'},
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#1976d2',
  },
  input: {
    marginHorizontal: 12,
    marginVertical: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderRadius: 6,
    fontSize: 14,
    color: '#111',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pathPreview: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    color: '#555',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  folderRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  folderBtn: {
    backgroundColor: '#1976d2',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  folderBtnText: {color: '#fff', fontSize: 14, fontWeight: '600'},
  folderClear: {
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#ececec',
  },
  folderClearText: {color: '#555', fontSize: 13},
  uriPreview: {
    fontSize: 11,
    color: '#888',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 4,
  },
  statusRow: {marginTop: 20, alignItems: 'center'},
  statusText: {fontSize: 12, color: '#888'},
});