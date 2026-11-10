import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { RouteTimetable, Stop } from '../utils/gtfs';

import { useTransitJourneyTimes } from './useTransitJourneyTimes';

const data = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/gtfs', () => ({ fetchRouteTimetable: data.fetch }));
vi.mock('./useInitialData', () => ({
  useInitialData: () => ({
    calendar: { '20261110': 'today' },
    loading: false,
  }),
}));
let root: ReturnType<typeof createRoot> | undefined;
let result: ReturnType<typeof useTransitJourneyTimes>;
const stops = new Map<string, Stop>(
  ['a', 'b', 'c'].map((id) => [id, { id, parentStation: null } as Stop])
);
function Probe({ to }: { to: string }) {
  const current = useTransitJourneyTimes(['5'], 'a', to, stops, 'data');
  useEffect(() => {
    result = current;
  }, [current]);
  return null;
}
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});
function start() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 10, 1, 5));
  root = createRoot(document.createElement('div'));
}

it('keeps availability pending until the timetable resolves', async () => {
  start();
  let resolve!: (table: RouteTimetable) => void;
  data.fetch.mockImplementation(
    () =>
      new Promise<RouteTimetable>((done) => {
        resolve = done;
      })
  );
  await act(async () => {
    root?.render(<Probe to="b" />);
  });
  expect(result.loading).toBe(true);
  await act(async () => {
    resolve({
      today_run: [
        ['a', 1, 100],
        ['b', 2, 110],
      ],
    });
  });
  expect(result.loading).toBe(false);
  expect(result.times.get('5')?.tripId).toBe('today_run');
});

it('ignores a stale response after the destination changes', async () => {
  start();
  const requests: ((table: RouteTimetable) => void)[] = [];
  data.fetch.mockImplementation(
    () =>
      new Promise<RouteTimetable>((resolve) => {
        requests.push(resolve);
      })
  );
  await act(async () => {
    root?.render(<Probe to="b" />);
  });
  await act(async () => {
    root?.render(<Probe to="c" />);
  });
  await act(async () => {
    requests[0]({
      today_old: [
        ['a', 1, 100],
        ['b', 2, 110],
      ],
    });
  });
  expect(result.loading).toBe(true);
  expect(result.times.get('5')).toBeUndefined();
  await act(async () => {
    requests[1]({
      today_new: [
        ['a', 1, 100],
        ['c', 2, 120],
      ],
    });
  });
  expect(result.loading).toBe(false);
  expect(result.times.get('5')?.tripId).toBe('today_new');
});
