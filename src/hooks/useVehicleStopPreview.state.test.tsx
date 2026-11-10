import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Stop } from '../utils/gtfs';

import { useVehicleStopPreview } from './useVehicleStopPreview';

const data = vi.hoisted(() => ({ lastUpdate: 0 }));
vi.mock('../contexts/GTFSModeContext', () => ({ useGTFSMode: () => ({ dataDir: 'data' }) }));
vi.mock('./useStaticTripResolver', () => ({
  useStaticTripResolver: () => ({ resolve: (id: string) => id }),
}));
vi.mock('../stores/realtimeStore', () => ({
  useRealtimeStore: (select: (s: object) => unknown) => select(data),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

async function preview(start: number, end: number, age = 0) {
  vi.useFakeTimers();
  const now = new Date(2026, 10, 10, 1, 5).getTime();
  vi.setSystemTime(now);
  data.lastUpdate = now - age * 1000;
  const stops = new Map<string, Stop>(
    ['a', 'b'].map((id, i) => [
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
  let result: ReturnType<typeof useVehicleStopPreview>;
  function Probe() {
    result = useVehicleStopPreview({
      activeTripId: 'trip',
      clickedVehiclePos: {
        latitude: 45,
        longitude: 15,
        routeId: '12',
        speed: 0,
        stationarySeconds: 0,
        tripId: 'trip',
      },
      routeTimetable: {
        trip: [
          ['a', 1, start],
          ['b', 2, end],
        ],
      },
      stopsById: stops,
    });
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(<Probe />);
  });
  return result!;
}
describe('focused vehicle service state', () => {
  it('marks a future trip near its origin without an on-time claim', async () => {
    const result = await preview(250, 270);
    expect(result?.serviceState).toBe('pending');
    expect(result?.delayInfo).toBeNull();
  });
  it('keeps a previous-day overnight journey in service', async () => {
    expect((await preview(1380, 1530))?.serviceState).toBe('approaching');
  });
  it('flags a feed that has stopped refreshing', async () => {
    expect((await preview(30, 100, 120))?.serviceState).toBe('stale');
  });
});
