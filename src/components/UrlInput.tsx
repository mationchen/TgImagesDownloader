import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { extractWebUrls, validateWebUrl } from '../utils/url';
import { t, useI18n } from '../i18n';
import { useTheme, useThemedStyles, type ThemeColors } from '../theme';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  /**
   * Invoked when the user taps the "Paste" button (left of "Clear"). The
   * parent reads the clipboard, extracts the first http(s) URL, and merges
   * it into the input.
   */
  onPaste: () => void;
  loading: boolean;
  pasting?: boolean;
  /** Optional outer container style. When provided, the bottom padding
   * (originally for tab-bar safe-area) is dropped so the input can be
   * placed inside the scroll/layout flow. */
  containerStyle?: StyleProp<ViewStyle>;
};

export const UrlInput: React.FC<Props> = ({
  value,
  onChange,
  onSubmit,
  onClear,
  onPaste,
  loading,
  pasting,
  containerStyle,
}) => {
  // Subscribe so the placeholder/buttons re-render in the active language.
  useI18n();
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const detected = extractWebUrls(value);
  const detectedCount = detected.length;
  const firstUrl = detected[0];
  const firstValid = firstUrl ? validateWebUrl(firstUrl) === null : false;
  // Single-link mode: parsing is only allowed when exactly one link is present.
  const hasMultiple = detectedCount > 1;
  const canParse = !loading && firstValid && !hasMultiple;

  return (
    <View
      style={
        containerStyle
          ? [styles.wrap, containerStyle]
          : [styles.wrap, { paddingBottom: 12 + insets.bottom }]
      }
    >
      <TextInput
        style={styles.input}
        multiline
        value={value}
        onChangeText={onChange}
        placeholder={t('home.inputPlaceholder')}
        placeholderTextColor={colors.textHint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textAlignVertical="top"
      />
      <View style={styles.metaRow}>
        <Text
          style={[styles.metaText, hasMultiple && styles.metaTextWarning]}
          numberOfLines={2}
        >
          {hasMultiple
            ? t('home.multipleUrls')
            : t('home.detectedUrls', { count: detectedCount })}
        </Text>
        <View style={styles.actionGroup}>
          <Pressable
            onPress={onPaste}
            disabled={!!pasting}
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionBtn,
              pasting && styles.disabled,
              pressed && !pasting && styles.pressed,
            ]}
          >
            <Text style={styles.actionText}>{t('home.paste')}</Text>
          </Pressable>
          <Pressable
            onPress={onClear}
            disabled={!value}
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionBtn,
              !value && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.actionText}>{t('home.clear')}</Text>
          </Pressable>
        </View>
      </View>
      <Pressable
        onPress={onSubmit}
        disabled={!canParse}
        style={({ pressed }) => [
          styles.submitBtn,
          !canParse && styles.disabled,
          pressed && canParse && styles.pressed,
        ]}
      >
        <Text style={styles.submitText}>{t('home.parse')}</Text>
      </Pressable>
    </View>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: c.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    input: {
      minHeight: 96,
      maxHeight: 160,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      padding: 12,
      fontSize: 15,
      color: c.textPrimary,
      backgroundColor: c.surface,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 8,
    },
    metaText: {
      flex: 1,
      paddingRight: 8,
      fontSize: 12,
      color: c.textSecondary,
    },
    metaTextWarning: {
      color: c.danger,
      fontWeight: '500',
    },
    actionGroup: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    actionBtn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
    },
    actionText: {
      color: c.primary,
      fontSize: 13,
    },
    submitBtn: {
      marginTop: 12,
      backgroundColor: c.primary,
      paddingVertical: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    submitText: {
      color: c.textOnPrimary,
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
}
