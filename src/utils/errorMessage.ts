import type { ParseErrorCode } from '../types/telegraph';
import type { StringKey } from '../i18n';
import { t } from '../i18n';

const ERROR_KEY_BY_CODE: Record<ParseErrorCode, StringKey> = {
  INVALID_URL: 'error.invalidUrl',
  NETWORK_ERROR: 'error.network',
  TIMEOUT: 'error.timeout',
  HTTP_NOT_FOUND: 'error.httpNotFound',
  HTTP_FORBIDDEN: 'error.httpForbidden',
  HTTP_SERVER_ERROR: 'error.httpServerError',
  PARSE_ERROR: 'error.parseError',
  NO_IMAGES: 'error.noImages',
  RESPONSE_TOO_LARGE: 'error.responseTooLarge',
  UNKNOWN: 'error.unknown',
};

export function errorMessage(
  code: ParseErrorCode | undefined,
  fallback?: string,
): string {
  if (!code) return fallback ?? t('error.unknown');
  return t(ERROR_KEY_BY_CODE[code]);
}
