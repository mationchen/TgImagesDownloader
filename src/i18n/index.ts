import {APP_CONFIG, type SupportedLocale} from '../constants/config';
import {zhCN} from './zh-CN';
import {en} from './en';

export type StringKey = keyof typeof zhCN;
export type InterpolationValues = Record<string, string | number>;

const dictionaries = { 'zh-CN': zhCN, en } as const;

function interpolate(
  template: string,
  values?: InterpolationValues,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? match : String(v);
  });
}

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
    locale = maybeLocale ?? APP_CONFIG.i18n.defaultLocale;
  }
  const dict = dictionaries[locale] ?? dictionaries[APP_CONFIG.i18n.defaultLocale];
  const raw = (dict as Record<string, string>)[key];
  if (raw === undefined) return key;
  return interpolate(raw, values);
}

export function getLocale(): SupportedLocale {
  return APP_CONFIG.i18n.defaultLocale;
}
