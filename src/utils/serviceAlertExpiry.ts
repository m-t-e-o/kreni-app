import type { ParsedServiceAlert } from './realtime';

const zagrebDate = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Zagreb',
  year: 'numeric',
});

/** A source-verified date remains valid for the entire Zagreb calendar day. */
export function isExpiredServiceAlert(alert: ParsedServiceAlert, nowMs: number): boolean {
  const end = alert.confirmedEndDate;
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  const parsed = new Date(`${end}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== end) return false;
  const parts = zagrebDate.formatToParts(nowMs);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return end < `${part('year')}-${part('month')}-${part('day')}`;
}
