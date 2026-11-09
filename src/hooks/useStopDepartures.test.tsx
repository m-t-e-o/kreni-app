import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Route, Stop } from '../utils/gtfs';

import { DepartureCard } from '../components/common/DepartureCard';
import { useStopDepartures } from './useStopDepartures';

const fixtures = vi.hoisted(() => ({
  fetchRouteActiveTrips: vi.fn(),
  fetchRouteStops: vi.fn(),
  fetchRouteTimetable: vi.fn(),
  fetchStopTimetable: vi.fn(),
  positions: new Map(),
}));
vi.mock('../utils/gtfs', async (original) => ({
  ...(await original<object>()),
  fetchRouteActiveTrips: fixtures.fetchRouteActiveTrips,
  fetchRouteStops: fixtures.fetchRouteStops,
  fetchRouteTimetable: fixtures.fetchRouteTimetable,
  fetchStopTimetable: fixtures.fetchStopTimetable,
}));
vi.mock('../stores/realtimeStore', () => ({
  useRealtimeStore: (select: (state: object) => unknown) =>
    select({ tripUpdates: new Map(), vehiclePositions: fixtures.positions }),
}));
vi.mock('./useInitialData', () => ({ useInitialData: () => ({ calendar: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const now = new Date(2026, 10, 10, 0, 36).getTime();
const routes = new Map<string, Route>([
  ['5', { id: '5', longName: 'Route 5', shortName: '5', type: 0 }],
]);
const container = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof useStopDepartures>;
let testId = 0;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
});

async function board(
  lon: number,
  canonical: boolean,
  missingCoordinate = false,
  headsign?: string
) {
  // Unique trip/stop keys isolate the intentional module-level passed-trip memory.
  const target = `target-${testId++}`;
  const trip = `trip-${testId}`;
  const ids = ['a', target, 'c'];
  const stops = new Map<string, Stop>(
    ids.map((id, i) => [
      id,
      {
        code: id,
        id,
        lat: 45,
        locationType: 0,
        lon: 15 + i * 0.01,
        name: id,
        parentStation: null,
      },
    ])
  );
  fixtures.positions = new Map([
    [trip, { latitude: 45, longitude: lon, routeId: headsign ? '5' : undefined, speed: 5 }],
  ]);
  fixtures.fetchRouteActiveTrips.mockResolvedValue({ trips: [{ headsign, id: trip }] });
  fixtures.fetchStopTimetable.mockResolvedValue({ '5': { [trip]: { sequence: 2, time: 51 } } });
  fixtures.fetchRouteStops.mockResolvedValue({
    orderedStops: {
      '0': canonical ? [...(missingCoordinate ? ['missing'] : []), ...ids] : ['a', 'c'],
    },
    stops: ids,
  });
  fixtures.fetchRouteTimetable.mockResolvedValue({
    [trip]: ids.map((id, i) => [id, i + 1, 50 + i]),
  });
  function Probe() {
    result = useStopDepartures(target, routes, stops, now);
    return null;
  }
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  expect(result.loading).toBe(false);
  return result.departures;
}

describe('stop board GPS regression cases', () => {
  it('uses the live trip headsign without changing canonical route topology', async () => {
    const [departure] = await board(15.008, true, false, 'Spr. Trešnj.');
    expect(departure.tripDestinationName).toBe('Spr. Trešnj.');
    expect(departure.routeLongName).toBe('Route 5');
  });

  it('falls back to the normal destination before live metadata is available', async () => {
    const [departure] = await board(15.008, true);
    expect(departure.tripDestinationName).toBe('c');
    expect(fixtures.fetchRouteActiveTrips).not.toHaveBeenCalled();
  });
  it('recognizes a passed depot journey outside canonical stop lists', async () => {
    const [departure] = await board(15.012, false);
    expect(departure.passedStop).toBe(true);
    expect(result.liveCount).toBe(0);
    expect(departure.etaFromGpsSeconds).toBeNull();
  });

  it('drops a variant journey once it is more than 400 m past', async () => {
    expect(await board(15.018, false)).toEqual([]);
  });

  it('keeps approaching variant journeys with consistent GPS arrival clocks', async () => {
    const [departure] = await board(15.008, false);
    expect(departure.passedStop).toBe(false);
    expect(departure.etaSeconds).toBeGreaterThan(0);
    expect(departure.gpsArrivalMinutes).toBeCloseTo(36 + departure.etaSeconds / 60);
    expect(departure.scheduledMinutes).toBe(51);
  });

  it('preserves the boarding tolerance for GPS jitter just beyond the platform', async () => {
    const [departure] = await board(15.0101, true);
    expect(departure.passedStop).toBe(false);
    expect(fixtures.fetchRouteTimetable).not.toHaveBeenCalled();
  });

  it('keeps target indexes aligned when canonical coordinates are missing', async () => {
    const [departure] = await board(15.012, true, true);
    expect(departure.passedStop).toBe(true);
  });

  it('leaves approaching canonical journeys live without fetching a full timetable', async () => {
    const [departure] = await board(15.008, true);
    expect(departure.passedStop).toBe(false);
    expect(result.liveCount).toBe(1);
    expect(fixtures.fetchRouteTimetable).not.toHaveBeenCalled();
  });

  it('renders the GPS clock instead of the unrelated schedule in both card layouts', async () => {
    const [departure] = await board(15.008, false);
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(
        <DepartureCard
          compact={compact}
          departure={{
            ...departure,
            etaSeconds: 60,
            gpsArrivalMinutes: 37,
          }}
        />
      );
      expect(html).toContain('00:37');
      expect(html).not.toContain('00:51');
    }
  });

  it('preserves scheduled clocks and wraps live arrival clocks at midnight', async () => {
    const [departure] = await board(15.008, true);
    const scheduled = renderToStaticMarkup(
      <DepartureCard departure={{ ...departure, hasGps: false }} />
    );
    expect(scheduled).toContain('00:51');
    const overnight = renderToStaticMarkup(
      <DepartureCard departure={{ ...departure, gpsArrivalMinutes: 1442 }} />
    );
    expect(overnight).toContain('00:02');
  });
});
