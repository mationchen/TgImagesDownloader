import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles, type ThemeColors } from '../theme';

type Props = {
  title?: string;
  hint?: string;
};

export const EmptyState: React.FC<Props> = ({ title, hint }) => {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
};

type LoadingProps = {
  message?: string;
};

export const LoadingState: React.FC<LoadingProps> = ({ message }) => {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" />
      {message ? <Text style={styles.hint}>{message}</Text> : null}
    </View>
  );
};

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 32,
    },
    title: {
      fontSize: 16,
      fontWeight: '500',
      color: c.textSecondary,
      textAlign: 'center',
    },
    hint: {
      marginTop: 8,
      fontSize: 13,
      color: c.textHint,
      textAlign: 'center',
      lineHeight: 18,
    },
  });
}
