import { describe, expect, it } from 'vitest';

import type { RouteTimetable, Stop } from './gtfs';

import { nextTransitJourney } from './transitJourneyTime';

const now = new Date(2026, 10, 10, 1, 5).getTime();
const stops = new Map(['a1', 'b1', 'c1'].map((id) => [id, { id, parentStation: id[0] } as Stop]));
const calendar = { '20261109': 'yesterday', '20261110': 'today', '20261111': 'tomorrow' };
const tt: RouteTimetable = {
  today_day: [
    ['a1', 1, 250],
    ['b1', 2, 265],
  ],
  today_wrongDirection: [
    ['b1', 1, 80],
    ['a1', 2, 90],
  ],
  wrong_service: [
    ['a1', 1, 66],
    ['b1', 2, 70],
  ],
  yesterday_night: [
    ['a1', 1, 1512],
    ['b1', 2, 1522],
  ],
};
describe('transit journey timetable availability', () => {
  it('prefers the overnight departure to a day route that starts hours later', () => {
    const next = nextTransitJourney(tt, 'a', 'b', stops, calendar, now)!;
    expect(next.tripId).toBe('yesterday_night');
    expect(new Date(next.departureMs).getHours()).toBe(1);
    expect(new Date(next.departureMs).getMinutes()).toBe(12);
  });
  it('matches both endpoints on the same trip in traversal order', () => {
    expect(
      nextTransitJourney(
        {
          today_short: [
            ['a1', 1, 80],
            ['c1', 2, 90],
          ],
        },
        'a',
        'b',
        stops,
        calendar,
        now
      )
    ).toBeNull();
    expect(
      nextTransitJourney({ today_reverse: tt.today_wrongDirection }, 'a', 'b', stops, calendar, now)
    ).toBeNull();
  });
  it('refuses missing calendars and supports tomorrow without resurrecting passed trips', () => {
    expect(nextTransitJourney(tt, 'a', 'b', stops, {}, now)).toBeNull();
    const next = nextTransitJourney(
      {
        tomorrow_run: [
          ['a1', 1, 60],
          ['b1', 2, 70],
        ],
      },
      'a',
      'b',
      stops,
      calendar,
      now
    )!;
    expect(new Date(next.departureMs).getDate()).toBe(11);
    expect(next.departureMs).toBeGreaterThan(now);
  });
  it('supports loops, selecting an occurrence that still reaches the destination', () => {
    const next = nextTransitJourney(
      {
        today_loop: [
          ['a1', 1, 60],
          ['b1', 2, 62],
          ['a1', 3, 90],
          ['b1', 4, 100],
        ],
      },
      'a',
      'b',
      stops,
      calendar,
      now
    )!;
    expect(new Date(next.departureMs).getMinutes()).toBe(30);
    expect(next.arrivalMs - next.departureMs).toBe(10 * 60_000);
  });
});
