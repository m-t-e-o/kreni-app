import { describe, expect, it } from 'vitest';

import type { ParsedServiceAlert } from './realtime';

import { isExpiredServiceAlert } from './serviceAlertExpiry';

const alert = { confirmedEndDate: '2026-11-08' } as ParsedServiceAlert;
describe('source-verified notice expiry', () => {
  it('keeps date-only notices until Zagreb midnight, regardless of device timezone', () => {
    expect(isExpiredServiceAlert(alert, Date.parse('2026-11-08T22:59:59Z'))).toBe(false);
    expect(isExpiredServiceAlert(alert, Date.parse('2026-11-08T23:00:00Z'))).toBe(true);
  });
  it('uses summer time and handles year crossings', () => {
    expect(
      isExpiredServiceAlert(
        { ...alert, confirmedEndDate: '2026-07-08' },
        Date.parse('2026-07-08T21:59:59Z')
      )
    ).toBe(false);
    expect(
      isExpiredServiceAlert(
        { ...alert, confirmedEndDate: '2026-07-08' },
        Date.parse('2026-07-08T22:00:00Z')
      )
    ).toBe(true);
    expect(
      isExpiredServiceAlert(
        { ...alert, confirmedEndDate: '2027-01-02' },
        Date.parse('2026-12-31T23:30:00Z')
      )
    ).toBe(false);
  });
  it('never expires uncertain or malformed dates', () => {
    for (const date of [undefined, null, '', '2026-02-30', '2026-13-01']) {
      expect(
        isExpiredServiceAlert({ ...alert, activeUntil: 1, confirmedEndDate: date }, Date.now())
      ).toBe(false);
    }
  });
});
