import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {t} from '../i18n';
import {extractTelegraphUrls, isValidTelegraphUrl} from '../utils/url';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  loading: boolean;
};

export const UrlInput: React.FC<Props> = ({
  value,
  onChange,
  onSubmit,
  onClear,
  loading,
}) => {
  const insets = useSafeAreaInsets();
  const detected = extractTelegraphUrls(value);
  const detectedCount = detected.length;
  const firstUrl = detected[0];
  const firstValid = firstUrl ? isValidTelegraphUrl(firstUrl) : false;
  const canParse = !loading && firstValid;

  return (
    <View style={[styles.wrap, {paddingBottom: 12 + insets.bottom}]}>
      <TextInput
        style={styles.input}
        multiline
        value={value}
        onChangeText={onChange}
        placeholder={t('home.inputPlaceholder')}
        placeholderTextColor="#999"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textAlignVertical="top"
      />
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>
          {t('home.detectedUrls', {count: detectedCount})}
        </Text>
        <Pressable
          onPress={onClear}
          disabled={!value}
          hitSlop={8}
          style={({pressed}) => [
            styles.clearBtn,
            !value && styles.disabled,
            pressed && styles.pressed,
          ]}>
          <Text style={styles.clearText}>{t('home.clear')}</Text>
        </Pressable>
      </View>
      <Pressable
        onPress={onSubmit}
        disabled={!canParse}
        style={({pressed}) => [
          styles.submitBtn,
          !canParse && styles.disabled,
          pressed && canParse && styles.pressed,
        ]}>
        <Text style={styles.submitText}>{t('home.parse')}</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e5e5',
  },
  input: {
    minHeight: 96,
    maxHeight: 160,
    borderWidth: 1,
    borderColor: '#dcdcdc',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#222',
    backgroundColor: '#fafafa',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  metaText: {
    fontSize: 12,
    color: '#666',
  },
  clearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  clearText: {
    color: '#1976d2',
    fontSize: 13,
  },
  submitBtn: {
    marginTop: 12,
    backgroundColor: '#1976d2',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.75,
  },
});
