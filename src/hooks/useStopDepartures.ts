/**
 * Unified stop departure board.
 *
 * Merges the two previously separate projections of the same data:
 *   - the static timetable ("what should come", from stop_timetables/{stopId}.json)
 *   - live GPS vehicles ("what is actually approaching", from realtimeStore.vehiclePositions)
 *
 * Both sources are keyed by `tripId`, so a scheduled departure and its live vehicle are
 * the *same row* — we never show them as two competing lists. Each row carries a
 * `confidence` tier ('live' when a GPS position exists, 'scheduled' otherwise) plus the
 * GPS facts (distance, stops away, passed-stop) when available.
 *
 * Trust model: the GPS position (lat/lon) is the only realtime signal treated as ground
 * truth on this feed. Live rows derive their ETA (countdown + ordering) from it; the
 * schedule and stop-level delays drive scheduled-only rows; trip-level delays are
 * frequently 0/stale and are surfaced as display hints only, never as the ETA of a
 * live row — otherwise a tram stuck in traffic shows "Sada" indefinitely while its own
 * GPS says it is still kilometres away.
 *
 * Data quality: a trip is included when it belongs to today's active service *or* when it
 * currently has a live GPS position — i.e. we trust realtime over the static calendar.
 * This re-links the "live vehicle with no timetable entry" orphans that arise from
 * service-day prefix mismatches or stale static stop-times for badly delayed trips.
 *
 * No new backend endpoint is needed — all data exists in existing indexes + realtime store.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ActiveTrip,
  Route,
  RouteStopsData,
  RouteTimetable,
  Stop,
  StopTimetable,
} from '../utils/gtfs';

import { useRealtimeStore } from '../stores/realtimeStore';
import {
  fetchRouteActiveTrips,
  fetchRouteStops,
  fetchRouteTimetable,
  fetchStopTimetable,
} from '../utils/gtfs';
import { indexByTripKey, matchRealtime } from '../utils/tripIdMatch';
import { computeVehicleStopProgress } from '../utils/vehicles';
import { useInitialData } from './useInitialData';

export interface StopDeparture {
  /** Adjusted clock time (minutes from midnight): scheduledMinutes + delaySeconds/60 */
  adjustedMinutes: number;
  /** 'live' = has a GPS position; 'scheduled' = timetable only (may still carry a delay) */
  confidence: 'live' | 'scheduled';
  /** Realtime delay in seconds at this stop; null = no realtime data */
  delaySeconds: null | number;
  /** Straight-line distance vehicle → stop in metres; null = no GPS */
  distanceMeters: null | number;
  /** GPS-derived ETA in seconds (distance / speed); null = no GPS or already passed */
  etaFromGpsSeconds: null | number;
  /**
   * Fused best estimate of seconds until arrival (used for ordering + countdown).
   * GPS-derived for live rows; delay-adjusted schedule for scheduled-only rows.
   */
  etaSeconds: number;
  /** GPS arrival clock time, from the same snapshot as etaSeconds. */
  gpsArrivalMinutes: number;
  /** True when the GPS position has been frozen in place long enough (~4 min) that it can no longer be treated as fresh motion */
  gpsStale: boolean;
  /** True when a GPS position is matched to this trip */
  hasGps: boolean;
  lat: null | number;
  lon: null | number;
  /** True when the vehicle has already passed this stop but is still nearby */
  passedStop: boolean;
  /** Whether realtime delay was matched at stop level, trip level, or not at all */
  realtimeSource: 'stop' | 'trip' | null;
  routeId: string;
  routeLongName: string;
  routeShortName: string;
  routeType: number; // 0 = Tram, 3 = Bus
  /** Scheduled minutes from midnight (may exceed 1440 for after-midnight trips) */
  scheduledMinutes: number;
  /** Stops the vehicle must still serve before this one (0 = approaching this stop directly); null = GPS not available */
  stopsAway: null | number;
  /** Trip terminus for this direction (last stop name), shown instead of route long name */
  tripDestinationName: string;
  tripId: string;
  /** Vehicle ID from GTFS-RT; null when no live position */
  vehicleId: null | string;
}

/** Allow trips that arrived up to this many seconds ago (grace window for scheduled rows) */
const ARRIVED_GRACE_SECONDS = 30;
/** A GPS position stationary longer than this is flagged stale (frozen transponder or long stop) */
const GPS_STALE_STATIONARY_SECONDS = 240;
/** When a GPS trip's scheduled ETA is past the lookahead window, still show it if this close */
const GPS_OUTSIDE_SCHEDULE_WINDOW_MAX_M = 15_000;
/** Keep GPS-tracked vehicles visible until they are this many metres past the stop */
const PASSED_STOP_DISTANCE_METERS = 400;
/** Within this distance a "projected past" vehicle is still treated as serving the stop (GPS noise while boarding) */
const PASSED_STOP_NEAR_METERS = 75;
/** How long a GPS-confirmed pass suppresses the trip's scheduled-only row */
const PASSED_TRIP_MEMORY_MS = 30 * 60 * 1000;

/**
 * GPS-confirmed passes per (stopId, tripId) → wall-clock ms first observed.
 * Module-level so it survives re-renders and is shared between hook instances.
 * An early-running vehicle drops out of the GPS feed when it finishes its trip; without
 * this memory its still-in-the-future timetable entry would resurrect as a scheduled-only
 * "arriving in X min" row for a vehicle that already served the stop.
 */
const passedTripMemory = new Map<string, number>();
const PASSED_TRIP_MEMORY_MAX_ENTRIES = 500;

export function useStopDepartures(
  stopId: null | string,
  routesById: Map<string, Route>,
  stopsById: Map<string, Stop>,
  nowMs: number, // Date.now() — updated every second by caller for live countdown
  options: { dataDir?: string; lookaheadMinutes?: number } = {}
): {
  departures: StopDeparture[];
  error: Error | null;
  isAllTerminus: boolean;
  liveCount: number;
  loading: boolean;
} {
  const { dataDir = 'data', lookaheadMinutes = 60 } = options;
  const [stopTimetable, setStopTimetable] = useState<null | StopTimetable>(null);
  const [routeStopsCache, setRouteStopsCache] = useState<Map<string, RouteStopsData>>(new Map());
  const [tripStopsCache, setTripStopsCache] = useState<Map<string, RouteTimetable>>(new Map());
  const [tripMetadata, setTripMetadata] = useState<Map<string, Map<string, ActiveTrip>>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const vehiclePositions = useRealtimeStore((s) => s.vehiclePositions);
  const tripUpdates = useRealtimeStore((s) => s.tripUpdates);
  const { calendar } = useInitialData({ dataDir });

  // Reuse the compressed per-route index only for routes with GPS vehicles on
  // this board. A changing position must not refetch the same route's metadata.
  const liveRouteKey = [
    ...new Set(
      [...vehiclePositions.values()]
        .map((pos) => pos.routeId)
        .filter((id): id is string => !!id && !!stopTimetable?.[id])
    ),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    let cancelled = false;
    setTripMetadata(new Map());
    if (!liveRouteKey) return;
    Promise.all(
      liveRouteKey.split(',').map(async (id) => {
        try {
          const data = await fetchRouteActiveTrips(id, dataDir);
          return [id, new Map(data.trips.map((trip) => [trip.id, trip]))] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (!cancelled) setTripMetadata(new Map(entries.filter((entry) => entry !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [dataDir, liveRouteKey]);

  // Secondary indexes for the service-prefix drift fallback. Built once per feed
  // poll rather than per trip — the departure loop runs over every trip at the
  // stop, and re-deriving these inside it would be quadratic.
  const vehiclePositionsByKey = useMemo(() => indexByTripKey(vehiclePositions), [vehiclePositions]);
  const tripUpdatesByKey = useMemo(() => indexByTripKey(tripUpdates), [tripUpdates]);

  // Track the stopId for which data is currently being fetched (stale-check guard)
  const fetchingForStopId = useRef<null | string>(null);

  useEffect(() => {
    if (!stopId) {
      setStopTimetable(null);
      setRouteStopsCache(new Map());
      setTripStopsCache(new Map());
      setError(null);
      return;
    }

    fetchingForStopId.current = stopId;
    setLoading(true);
    setError(null);
    // Clear immediately so the memo never pairs the new stopId with the previous
    // stop's timetable/topology while the fetch is in flight.
    setStopTimetable(null);
    setRouteStopsCache(new Map());
    setTripStopsCache(new Map());

    fetchStopTimetable(stopId, dataDir)
      .then(async (timetable) => {
        // Bail out if the user already switched to a different stop
        if (fetchingForStopId.current !== stopId) return;

        // Fetch route_stops in parallel for all routes at this stop (~320 B each, cached)
        const routeIds = Object.keys(timetable);
        const settled = await Promise.all(
          routeIds.map(async (routeId) => {
            try {
              const data = await fetchRouteStops(routeId, dataDir);
              return [routeId, data] as const;
            } catch {
              return null;
            }
          })
        );

        if (fetchingForStopId.current !== stopId) return;

        const map = new Map<string, RouteStopsData>();
        for (const entry of settled) {
          if (entry) map.set(entry[0], entry[1]);
        }
        // Depot/variant journeys can serve platforms outside both canonical directions.
        // Only those routes need the larger per-trip topology to detect a GPS pass.
        const tripTopologies = await Promise.all(
          routeIds.map(async (routeId) => {
            const directions = Object.values(map.get(routeId)?.orderedStops ?? {});
            if (directions.some((ids) => ids.includes(stopId))) return null;
            try {
              return [routeId, await fetchRouteTimetable(routeId, dataDir)] as const;
            } catch {
              return null;
            }
          })
        );
        if (fetchingForStopId.current !== stopId) return;
        setTripStopsCache(new Map(tripTopologies.filter((entry) => entry !== null)));
        // Set timetable and topology together — a render with one but not the other
        // would compute departures against mismatched data.
        setStopTimetable(timetable);
        setRouteStopsCache(map);
        setLoading(false);
      })
      .catch((err) => {
        if (fetchingForStopId.current !== stopId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [stopId, dataDir]);

  const { departures, isAllTerminus } = useMemo<{
    departures: StopDeparture[];
    isAllTerminus: boolean;
  }>(() => {
    if (!stopId || !stopTimetable) return { departures: [], isAllTerminus: false };

    const nowSeconds = nowMs / 1000;
    const midnightSeconds = (() => {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      return d.getTime() / 1000;
    })();
    const windowEnd = nowSeconds + lookaheadMinutes * 60;

    // Today's active service ID — used to filter scheduled-only rows to today's calendar
    // slice. Derived from the *local* date: toISOString() is UTC and, this being UTC+1/+2,
    // would keep serving yesterday's calendar entry until 01:00/02:00 local.
    const localDateStr = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate()
      ).padStart(2, '0')}`;
    };
    const activeServiceId = calendar[localDateStr(nowMs)] ?? null;
    // Yesterday's service still owns its after-midnight (≥ 24:00) trips in the early hours
    const previousServiceId = calendar[localDateStr(nowMs - 86_400_000)] ?? null;

    const targetStop = stopsById.get(stopId);

    const results: StopDeparture[] = [];
    let routesInTopology = 0;
    let terminusRoutes = 0;

    for (const [routeId, trips] of Object.entries(stopTimetable)) {
      const route = routesById.get(routeId);
      if (!route) continue;

      const routeStopsData = routeStopsCache.get(routeId);

      // Determine which direction's ordered stop list contains our stopId
      let directionKey: null | string = null;
      let targetStopIndex = -1;
      if (routeStopsData?.orderedStops) {
        for (const [dir, stopList] of Object.entries(routeStopsData.orderedStops)) {
          const idx = stopList.indexOf(stopId);
          if (idx !== -1) {
            directionKey = dir;
            targetStopIndex = idx;
            break;
          }
        }
      }

      if (targetStopIndex >= 0 && directionKey !== null) {
        routesInTopology++;
      }

      // Skip routes where this stop is the terminal (last) stop — those trips are
      // arriving/terminating here, not departing.
      const dirStopIds =
        directionKey !== null ? (routeStopsData?.orderedStops?.[directionKey] ?? []) : [];
      if (
        targetStopIndex >= 0 &&
        dirStopIds.length > 1 &&
        targetStopIndex === dirStopIds.length - 1
      ) {
        terminusRoutes++;
        continue;
      }

      const destLastStopId = dirStopIds.length > 0 ? dirStopIds[dirStopIds.length - 1] : null;
      const tripDestinationName =
        destLastStopId !== null
          ? (stopsById.get(destLastStopId)?.name ?? route.longName)
          : route.longName;

      for (const [tripId, { time: scheduledMinutes }] of Object.entries(trips)) {
        // Service membership is now needed *before* the GPS lookup, not just after:
        // it is what makes the drift fallback in `matchRealtime` unambiguous.
        const inTodayService = activeServiceId !== null && tripId.startsWith(activeServiceId + '_');
        const inOvernightService =
          scheduledMinutes >= 1440 &&
          previousServiceId !== null &&
          tripId.startsWith(previousServiceId + '_');
        const inActiveService = inTodayService || inOvernightService;

        // Exact ID first; on a miss, fall back to the publication-stable key, but
        // only for trips in an active service — see utils/tripIdMatch. This is what
        // keeps stop boards live when ZET's realtime and static feeds disagree on
        // the service prefix (the 2026-07-29 incident).
        const vehiclePos = matchRealtime(
          vehiclePositions,
          vehiclePositionsByKey,
          tripId,
          inActiveService
        );
        const hasGps = vehiclePos !== undefined;

        // Data quality: keep a scheduled-only row only when it belongs to today's service,
        // or to yesterday's service for after-midnight (≥ 24:00) trips still running.
        // Live GPS rows are kept regardless — we trust realtime over the static calendar.
        // (Drift-matched rows are already service-scoped by the check above, so this
        // continues to apply to exact matches only, exactly as before.)
        if (!hasGps && activeServiceId && !inActiveService) continue;

        // Suppress scheduled-only rows for trips we already saw pass this stop on GPS —
        // an early-running vehicle must not resurrect as "arriving" after its GPS drops.
        if (!hasGps) {
          const passedAtMs = passedTripMemory.get(`${stopId}|${tripId}`);
          if (passedAtMs !== undefined && nowMs - passedAtMs < PASSED_TRIP_MEMORY_MS) continue;
        }

        // Resolve delay: prefer stop-level match over trip-level
        let delaySeconds: null | number = null;
        let realtimeSource: 'stop' | 'trip' | null = null;
        const tripUpdate = matchRealtime(tripUpdates, tripUpdatesByKey, tripId, inActiveService);
        if (tripUpdate) {
          const stu = tripUpdate.stopTimeUpdates.find((s) => s.stopId === stopId);
          if (stu) {
            const d = stu.departureDelay ?? stu.arrivalDelay;
            if (d !== undefined) {
              delaySeconds = d;
              realtimeSource = 'stop';
            }
          }
          if (delaySeconds === null && tripUpdate.delay !== undefined) {
            delaySeconds = tripUpdate.delay;
            realtimeSource = 'trip';
          }
        }

        // Trip-level delay is frequently 0/stale on this feed: it stays a display hint
        // (`delaySeconds`/`adjustedMinutes`) but only stop-level delay may shift the
        // schedule for time math — except for scheduled-only rows, where any delay is
        // the sole realtime hint available.
        const etaDelaySeconds =
          realtimeSource === 'stop' ? (delaySeconds ?? 0) : hasGps ? 0 : (delaySeconds ?? 0);

        // GTFS times ≥ 24:00 can belong to yesterday's service day (running now, in the
        // early hours) or to today's (running tomorrow morning): pick the occurrence
        // closest to now.
        let serviceMidnightSeconds = midnightSeconds;
        if (scheduledMinutes >= 1440) {
          const todayBased = midnightSeconds + scheduledMinutes * 60;
          if (Math.abs(todayBased - 86_400 - nowSeconds) < Math.abs(todayBased - nowSeconds)) {
            serviceMidnightSeconds -= 86_400;
          }
        }

        // Scheduled (delay-adjusted) absolute arrival, in POSIX seconds
        const scheduledAbsoluteSeconds =
          serviceMidnightSeconds + scheduledMinutes * 60 + etaDelaySeconds;
        const scheduleArrivingInSeconds = scheduledAbsoluteSeconds - nowSeconds;

        const distanceMeters =
          vehiclePos && targetStop
            ? Math.round(
                haversineMeters(
                  vehiclePos.latitude,
                  vehiclePos.longitude,
                  targetStop.lat,
                  targetStop.lon
                )
              )
            : null;

        // GPS-derived stops away / passed-stop projection
        let stopsAway: null | number = null;
        let passedStop = false;
        const progressStopIds =
          targetStopIndex >= 0
            ? dirStopIds
            : (tripStopsCache.get(routeId)?.[tripId]?.map(([sid]) => sid) ?? []);
        if (vehiclePos && progressStopIds.length > 1) {
          // Keep the target index in the same coordinate list used for projection:
          // missing stop coordinates must not shift the target past the vehicle.
          const knownStopIds = progressStopIds.filter((sid) => stopsById.has(sid));
          const progressTargetIndex = knownStopIds.indexOf(stopId);
          const stopCoords = knownStopIds
            .map((sid) => {
              const s = stopsById.get(sid);
              return s ? { lat: s.lat, lon: s.lon } : null;
            })
            .filter((s): s is { lat: number; lon: number } => s !== null);

          if (progressTargetIndex >= 0 && stopCoords.length > 1) {
            const vehicleProgress = computeVehicleStopProgress(
              vehiclePos.latitude,
              vehiclePos.longitude,
              stopCoords
            );
            const rawStopsAway = progressTargetIndex - vehicleProgress;
            if (rawStopsAway < 0) {
              // Vehicle projects past this stop. The projection dips slightly negative
              // from GPS noise while a vehicle is boarding, so distance decides: within
              // platform range it is still serving the stop, beyond it it has passed.
              passedStop = distanceMeters === null || distanceMeters > PASSED_STOP_NEAR_METERS;
              stopsAway = 0;
            } else {
              // Stops still to serve before this one; 0 = approaching this stop directly
              stopsAway = Math.max(0, Math.ceil(rawStopsAway) - 1);
            }
          }
        }

        // Remember GPS-confirmed passes (before the distance filter below drops the row)
        // so this trip's scheduled entry stays suppressed once its GPS disappears.
        if (passedStop) {
          if (passedTripMemory.size > PASSED_TRIP_MEMORY_MAX_ENTRIES) {
            for (const [key, observedAtMs] of passedTripMemory) {
              if (nowMs - observedAtMs > PASSED_TRIP_MEMORY_MS) passedTripMemory.delete(key);
            }
          }
          const memoryKey = `${stopId}|${tripId}`;
          if (!passedTripMemory.has(memoryKey)) passedTripMemory.set(memoryKey, nowMs);
        }

        // ── Filtering: merge the rules of both former hooks ──
        if (hasGps) {
          // GPS rows can exceed the scheduled window (static stop-time often lags real
          // position); keep them when still geographically near the stop.
          if (scheduledAbsoluteSeconds > windowEnd) {
            if (distanceMeters === null || distanceMeters > GPS_OUTSIDE_SCHEDULE_WINDOW_MAX_M) {
              continue;
            }
          }
          // Passed vehicles drop out once they are well past the stop.
          if (
            passedStop &&
            distanceMeters !== null &&
            distanceMeters > PASSED_STOP_DISTANCE_METERS
          ) {
            continue;
          }
        } else {
          // Scheduled-only: strict time window with a small past grace.
          if (scheduleArrivingInSeconds < -ARRIVED_GRACE_SECONDS) continue;
          if (scheduledAbsoluteSeconds > windowEnd) continue;
        }

        // GPS-derived ETA: distance / smoothed speed (fallback 5 m/s city transit
        // estimate). Straight-line distance ≤ route distance, so this systematically
        // errs on the early side — the safe direction for a rider.
        let etaFromGpsSeconds: null | number = null;
        if (vehiclePos && distanceMeters !== null && !passedStop) {
          const speed = vehiclePos.speed ?? 5; // m/s
          etaFromGpsSeconds = Math.round(distanceMeters / Math.max(speed, 1));
        }

        // Fused ETA: for live rows the GPS position is the trusted signal — the schedule
        // (even delay-adjusted) may sit in the past while the vehicle is stuck in traffic,
        // which used to pin a green "Sada" on the board indefinitely. Scheduled-only rows
        // fall back to the delay-adjusted schedule. It also can never go negative for live
        // rows, so "Sada" now implies the vehicle is physically at the stop.
        const etaSeconds = etaFromGpsSeconds ?? scheduleArrivingInSeconds;

        const gpsStale =
          hasGps && (vehiclePos.stationarySeconds ?? 0) > GPS_STALE_STATIONARY_SECONDS;

        results.push({
          adjustedMinutes: scheduledMinutes + (delaySeconds ?? 0) / 60,
          confidence: hasGps ? 'live' : 'scheduled',
          delaySeconds,
          distanceMeters,
          etaFromGpsSeconds,
          etaSeconds,
          gpsArrivalMinutes: (nowSeconds - midnightSeconds + etaSeconds) / 60,
          gpsStale,
          hasGps,
          lat: vehiclePos?.latitude ?? null,
          lon: vehiclePos?.longitude ?? null,
          passedStop,
          realtimeSource,
          routeId,
          routeLongName: route.longName,
          routeShortName: route.shortName,
          routeType: route.type,
          scheduledMinutes,
          stopsAway,
          tripDestinationName: hasGps
            ? tripMetadata.get(routeId)?.get(tripId)?.headsign.trim() || tripDestinationName
            : tripDestinationName,
          tripId,
          vehicleId: vehiclePos?.vehicleId ?? null,
        });
      }
    }

    // Keep at most one "just passed" row (the closest by GPS distance) so a single missed
    // vehicle doesn't crowd the top of the board.
    const passed = results.filter((d) => d.passedStop);
    const upcoming = results.filter((d) => !d.passedStop);
    let keptPassed: StopDeparture[] = [];
    if (passed.length > 0) {
      keptPassed = [
        passed.reduce((a, b) => {
          const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
          const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
          if (da !== db) return da < db ? a : b;
          return a.etaSeconds > b.etaSeconds ? a : b;
        }),
      ];
    }

    // Order: just-passed first (informative "you just missed it"), then by fused ETA in
    // 30 s buckets — coarse enough that GPS jitter doesn't reshuffle rows every tick.
    // Ties break live-before-scheduled, then by tripId so the order stays deterministic.
    const etaBucket = (d: StopDeparture) => Math.round(d.etaSeconds / 30);
    upcoming.sort((a, b) => {
      const bucketDiff = etaBucket(a) - etaBucket(b);
      if (bucketDiff !== 0) return bucketDiff;
      if (a.hasGps !== b.hasGps) return a.hasGps ? -1 : 1;
      return a.tripId.localeCompare(b.tripId);
    });

    const isAllTerminus = routesInTopology > 0 && terminusRoutes === routesInTopology;
    return { departures: [...keptPassed, ...upcoming], isAllTerminus };
  }, [
    stopId,
    stopTimetable,
    routeStopsCache,
    tripStopsCache,
    tripMetadata,
    vehiclePositions,
    tripUpdates,
    vehiclePositionsByKey,
    tripUpdatesByKey,
    nowMs,
    stopsById,
    routesById,
    calendar,
    lookaheadMinutes,
  ]);

  const liveCount = departures.filter((d) => d.hasGps && !d.passedStop).length;

  return {
    departures,
    error,
    isAllTerminus,
    liveCount,
    loading: loading || (!!stopId && !stopTimetable && !error),
  };
}

/** Approximate haversine distance in metres between two lat/lon points */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
