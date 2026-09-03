import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import {
  getSettingsSync,
  loadSettings,
  saveSettings,
  type AppThemeMode,
} from '../services/settingsService';

/**
 * Central color palette consumed by every screen/component. All UI colors in
 * the app must come from here so that light/dark switching works everywhere,
 * instead of being hardcoded per screen.
 */
export interface ThemeColors {
  primary: string;
  background: string;
  surface: string;
  surfaceStrong: string;
  textPrimary: string;
  textSecondary: string;
  textHint: string;
  textOnPrimary: string;
  border: string;
  borderStrong: string;
  danger: string;
  dangerBg: string;
  success: string;
  warning: string;
  warningBg: string;
  tabInactive: string;
  headerBackground: string;
  headerTitle: string;
  backdrop: string;
  /** Soft tinted background for badges/chips/selected states. */
  primarySoft: string;
  /** Text/icons on top of primarySoft. */
  primarySoftText: string;
}

const light: ThemeColors = {
  primary: '#1976d2',
  background: '#fff',
  surface: '#f7f8fa',
  surfaceStrong: '#eef2f5',
  textPrimary: '#111',
  textSecondary: '#666',
  textHint: '#888',
  textOnPrimary: '#fff',
  border: '#e5e5e5',
  borderStrong: '#ccc',
  danger: '#c33',
  dangerBg: '#fde0e0',
  success: '#1b7a3a',
  warning: '#f0a020',
  warningBg: '#fff7e0',
  tabInactive: '#8a8a8a',
  headerBackground: '#fff',
  headerTitle: '#111',
  backdrop: 'rgba(0,0,0,0.35)',
  primarySoft: '#e3f0fc',
  primarySoftText: '#0d5fb8',
};

const dark: ThemeColors = {
  primary: '#4d9be6',
  background: '#0e1116',
  surface: '#1a1e25',
  surfaceStrong: '#242a33',
  textPrimary: '#f0f2f5',
  textSecondary: '#a9b0ba',
  textHint: '#7b838e',
  textOnPrimary: '#0e1116',
  border: '#2a303a',
  borderStrong: '#3a414d',
  danger: '#ef6a6a',
  dangerBg: 'rgba(239,106,106,0.15)',
  success: '#57c477',
  warning: '#f0a020',
  warningBg: 'rgba(240,160,32,0.15)',
  tabInactive: '#7b838e',
  headerBackground: '#0e1116',
  headerTitle: '#f0f2f5',
  backdrop: 'rgba(0,0,0,0.6)',
  primarySoft: 'rgba(77,155,230,0.22)',
  primarySoftText: '#8fc3f5',
};

export type { AppThemeMode };

interface ThemeContextValue {
  mode: AppThemeMode;
  isDark: boolean;
  colors: ThemeColors;
  setMode: (mode: AppThemeMode) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  isDark: false,
  colors: light,
  setMode: async () => undefined,
});

function resolveColors(mode: AppThemeMode, systemDark: boolean): ThemeColors {
  const darkActive = mode === 'dark' || (mode === 'system' && systemDark);
  return darkActive ? dark : light;
}

/**
 * App-wide theme provider. Resolves the user's preference
 * ({@link AppThemeMode}) against the OS color scheme and exposes the resolved
 * palette through {@link useTheme}. Changing the mode persists to settings.
 */
export const ThemeProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const systemDark = useColorScheme() === 'dark';
  const [mode, setModeState] = useState<AppThemeMode>(getSettingsSync().theme);

  // Load the persisted appearance on boot; the settings cache may be empty
  // at first render, so sync again here after loadSettings() resolves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSettings();
        if (!cancelled) {
          setModeState(prev => (prev === s.theme ? prev : s.theme));
        }
      } catch {
        // Keep the default; UI still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(async (next: AppThemeMode) => {
    setModeState(next);
    try {
      const s = await loadSettings();
      await saveSettings({ ...s, theme: next });
    } catch {
      // best-effort
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      isDark: mode === 'dark' || (mode === 'system' && systemDark),
      colors: resolveColors(mode, systemDark),
      setMode,
    }),
    [mode, systemDark, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

/** Consume the resolved theme (isDark + colors). */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Memoized themed style sheet. Pass a factory that maps a {@link ThemeColors}
 * palette to a StyleSheet; the result is rebuilt only when the palette's
 * identity changes (light <-> dark switches).
 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [factory, colors]);
}
