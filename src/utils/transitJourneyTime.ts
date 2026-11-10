import type { RouteTimetable, Stop } from './gtfs';

export interface TransitJourneyTime {
  arrivalMs: number;
  departureMs: number;
  tripId: string;
}

/** Schedule availability, not a GPS prediction. Matches both endpoints on one trip. */
export function nextTransitJourney(
  timetable: RouteTimetable,
  from: string,
  to: string,
  stopsById: Map<string, Stop>,
  calendar: Record<string, string>,
  nowMs: number
): null | TransitJourneyTime {
  let best: null | TransitJourneyTime = null;
  const parent = (id: string) => stopsById.get(id)?.parentStation || id;
  for (const offset of [-1, 0, 1]) {
    const day = new Date(nowMs);
    day.setDate(day.getDate() + offset);
    day.setHours(0, 0, 0, 0);
    const key = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    const service = calendar[key];
    if (!service) continue; // Never guess across weekday/weekend variants.
    for (const [tripId, stops] of Object.entries(timetable)) {
      if (!tripId.startsWith(`${service}_`)) continue;
      for (let i = 0; i < stops.length; i++) {
        if (parent(stops[i][0]) !== from) continue;
        const departureMs = day.getTime() + stops[i][2] * 60_000;
        if (departureMs < nowMs || departureMs > nowMs + 24 * 60 * 60_000) continue;
        const destination = stops.slice(i + 1).find(([id]) => parent(id) === to);
        if (!destination) continue;
        const arrivalMs = day.getTime() + destination[2] * 60_000;
        if (arrivalMs < departureMs) continue;
        if (
          !best ||
          departureMs < best.departureMs ||
          (departureMs === best.departureMs && arrivalMs < best.arrivalMs)
        ) {
          best = { arrivalMs, departureMs, tripId };
        }
      }
    }
  }
  return best;
}
