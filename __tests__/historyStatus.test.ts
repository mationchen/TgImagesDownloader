import {
  HISTORY_STATUS_LABEL_KEY,
  historyStatusVisual,
} from '../src/utils/historyStatus';
import type { HistoryStatus } from '../src/services/historyService';

const ALL: HistoryStatus[] = ['done', 'partial', 'failed', 'cancelled'];

describe('utils/historyStatus', () => {
  it('maps each status to a distinct glyph + tone', () => {
    const visuals = ALL.map(s => historyStatusVisual(s));
    expect(visuals.map(v => v.icon)).toEqual([
      '\u2713', // ✓
      '!', // !
      '\u2715', // ✕
      '\u2013', // –
    ]);
    expect(visuals.map(v => v.tone)).toEqual([
      'success',
      'warning',
      'danger',
      'neutral',
    ]);
  });

  it('falls back to the success glyph for unknown/legacy values', () => {
    expect(historyStatusVisual('legacy' as HistoryStatus)).toEqual({
      icon: '\u2713',
      tone: 'success',
    });
  });

  it('provides an i18n label key for every status', () => {
    for (const s of ALL) {
      expect(HISTORY_STATUS_LABEL_KEY[s]).toMatch(/^history\.status\./);
    }
  });
});
