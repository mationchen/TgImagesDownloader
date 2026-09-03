import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { APP_CONFIG, type SupportedLocale } from '../constants/config';

export type { SupportedLocale };
import {
  getSettingsSync,
  loadSettings,
  saveSettings,
} from '../services/settingsService';
import { zhCN } from './zh-CN';
import { en } from './en';

export type StringKey = keyof typeof zhCN;
export type InterpolationValues = Record<string, string | number>;

const dictionaries: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  en,
} as const;

/**
 * Module-level current locale. `t()` falls back to this when no explicit locale
 * is given. The runtime provider ({@link I18nProvider}) keeps it in sync with
 * the user's settings choice so every `t()` call reflects the active language.
 */
let currentLocale: SupportedLocale = APP_CONFIG.i18n.defaultLocale;

/** Set the module-level locale used by the raw `t()` function. */
export function setCurrentLocale(locale: SupportedLocale): void {
  currentLocale = dictionaries[locale] ? locale : APP_CONFIG.i18n.defaultLocale;
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

function interpolate(template: string, values?: InterpolationValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? match : String(v);
  });
}

/**
 * Translate {@code key} for {@code locale} (defaults to the module-level
 * current locale). Missing keys fall back to the default locale, then to the
 * raw key — never throws, never renders a bare untranslated string.
 */
export function t(
  key: StringKey,
  valuesOrLocale?: InterpolationValues | SupportedLocale,
  maybeLocale?: SupportedLocale,
): string {
  let values: InterpolationValues | undefined;
  let locale: SupportedLocale;
  if (typeof valuesOrLocale === 'string') {
    locale = valuesOrLocale;
  } else {
    values = valuesOrLocale;
    locale = maybeLocale ?? currentLocale;
  }
  const dict =
    dictionaries[locale] ?? dictionaries[APP_CONFIG.i18n.defaultLocale];
  const fallback =
    dictionaries[APP_CONFIG.i18n.defaultLocale] ?? dictionaries[locale];
  const raw =
    (dict as Record<string, string>)[key] ??
    (fallback as Record<string, string>)[key];
  if (raw === undefined) return key as string;
  return interpolate(raw, values);
}

/* ------------------------------------------------------------------ */
/* React runtime: language can be switched in Settings and applies live  */
/* ------------------------------------------------------------------ */

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => Promise<void>;
}

const I18nContext = createContext<I18nContextValue>({
  locale: APP_CONFIG.i18n.defaultLocale,
  setLocale: async () => undefined,
});

/**
 * React context that exposes the active UI language. Persisting a language
 * change also writes it into settings and updates the module-level locale so
 * the raw `t()` stays consistent for non-React callers.
 */
export const I18nProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [locale, setLocaleState] = useState<SupportedLocale>(
    getSettingsSync().locale,
  );

  // Load the persisted language on boot; the settings cache may be empty at
  // first render (screens call loadSettings() on mount), so sync again here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSettings();
        if (cancelled) return;
        setLocaleState(prev => (prev === s.locale ? prev : s.locale));
        setCurrentLocale(s.locale);
      } catch {
        // Keep the default; UI still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback(async (next: SupportedLocale) => {
    setCurrentLocale(next);
    setLocaleState(next);
    try {
      const s = await loadSettings();
      await saveSettings({ ...s, locale: next });
    } catch {
      // Best-effort persistence; UI still switches in this session.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

/** Hook for components that (re-)render when the language changes. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
