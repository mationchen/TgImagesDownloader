import type { HistoryStatus } from '../services/historyService';

/** Semantic colour family a status badge should be rendered in. */
export type HistoryStatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface HistoryStatusVisual {
  /** Monochrome glyph shown inside the badge. */
  icon: string;
  /** Tone the UI maps to theme colours (fg + soft bg). */
  tone: HistoryStatusTone;
}

/**
 * Badge glyph + tone for a history status. Monochrome glyphs (not emoji) so
 * they render in the theme colour on both platforms:
 *
 *   done      -> ✓  green
 *   partial   -> !  orange
 *   failed    -> ✕  red
 *   cancelled -> –  grey
 */
export function historyStatusVisual(
  status: HistoryStatus,
): HistoryStatusVisual {
  switch (status) {
    case 'done':
      return { icon: '\u2713', tone: 'success' };
    case 'partial':
      return { icon: '!', tone: 'warning' };
    case 'failed':
      return { icon: '\u2715', tone: 'danger' };
    case 'cancelled':
      return { icon: '\u2013', tone: 'neutral' };
    default:
      // Unknown/legacy value: treat as a completed run rather than showing a
      // bare, untranslated status string.
      return { icon: '\u2713', tone: 'success' };
  }
}

/**
 * i18n key for each status, used for labels and accessibility text.
 * `as const` keeps the literal types so the values stay assignable to
 * `StringKey`.
 */
export const HISTORY_STATUS_LABEL_KEY = {
  done: 'history.status.done',
  partial: 'history.status.partial',
  failed: 'history.status.failed',
  cancelled: 'history.status.cancelled',
} as const;
