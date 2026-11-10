export type VehicleServiceState = 'approaching' | 'pending' | 'stale' | 'stationary';

/** Timetable alone never cancels a live journey. Require GPS near its origin too. */
export function vehicleServiceState({
  feedAgeSeconds,
  originDistance,
  originProgress,
  speed,
  startInSeconds,
  stationarySeconds,
}: {
  feedAgeSeconds?: number;
  originDistance?: number;
  originProgress?: number;
  speed?: number;
  startInSeconds?: number;
  stationarySeconds?: number;
}): VehicleServiceState {
  if (feedAgeSeconds !== undefined && feedAgeSeconds > 90) return 'stale';
  if (
    startInSeconds !== undefined &&
    startInSeconds >= 30 * 60 &&
    originDistance !== undefined &&
    originDistance <= 600 &&
    originProgress !== undefined &&
    originProgress <= 0.5 &&
    speed !== undefined &&
    speed <= 1
  )
    return 'pending';
  if ((stationarySeconds ?? 0) >= 240) return 'stationary';
  return 'approaching';
}
