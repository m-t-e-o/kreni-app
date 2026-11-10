import { describe, expect, it } from 'vitest';

import { vehicleServiceState } from './vehicleServiceState';

const depot = {
  originDistance: 450,
  originProgress: 0.1,
  speed: 0,
  startInSeconds: 3 * 3600,
  stationarySeconds: 600,
};
describe('conservative vehicle service states', () => {
  it('does not promise an arrival for a slow vehicle near the origin of a future trip', () => {
    expect(vehicleServiceState(depot)).toBe('pending');
  });
  it('does not use timetable alone to suppress an early-running moving vehicle', () => {
    expect(vehicleServiceState({ ...depot, speed: 8, stationarySeconds: 0 })).toBe('approaching');
    expect(vehicleServiceState({ ...depot, originDistance: 1500, stationarySeconds: 0 })).toBe(
      'approaching'
    );
    expect(vehicleServiceState({ ...depot, originProgress: 2, stationarySeconds: 0 })).toBe(
      'approaching'
    );
    expect(vehicleServiceState({ ...depot, originDistance: undefined, stationarySeconds: 0 })).toBe(
      'approaching'
    );
  });
  it('keeps delays, boarding and brief red-light waits in the active path', () => {
    for (const startInSeconds of [-3600, -60, 0, 300]) {
      expect(vehicleServiceState({ ...depot, startInSeconds, stationarySeconds: 60 })).toBe(
        'approaching'
      );
    }
  });
  it('distinguishes unchanged positions from a feed that has stopped refreshing', () => {
    expect(vehicleServiceState({ stationarySeconds: 240 })).toBe('stationary');
    expect(vehicleServiceState({ stationarySeconds: 239 })).toBe('approaching');
    expect(vehicleServiceState({ feedAgeSeconds: 91 })).toBe('stale');
    expect(vehicleServiceState({ feedAgeSeconds: 90 })).toBe('approaching');
    expect(vehicleServiceState({ ...depot, feedAgeSeconds: 120 })).toBe('stale');
  });
});
