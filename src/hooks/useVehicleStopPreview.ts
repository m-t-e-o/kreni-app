import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RouteTimetable, Stop } from '../utils/gtfs';
import type { ParsedTripUpdate, ParsedVehiclePosition } from '../utils/realtime';
import type { VehiclePosition } from '../utils/vehicles';

import { useGTFSMode } from '../contexts/GTFSModeContext';
import { useRealtimeStore } from '../stores/realtimeStore';
import { formatDelay, formatMinutes, haversineMeters } from '../utils/format';
import { VehicleStopStatus } from '../utils/realtime';
import { computeVehicleStopProgress, getRouteVehicleStopPreview } from '../utils/vehicles';
import { vehicleServiceState, type VehicleServiceState } from '../utils/vehicleServiceState';
import { useStaticTripResolver } from './useStaticTripResolver';

export interface VehicleStopPreview {
  delayInfo: null | { positive: boolean; text: string };
  distanceMeters: null | number;
  primaryStopTime: null | string;
  serviceState?: VehicleServiceState;
  stopDetail: string;
  stopLabel: string;
  upcomingStops: { name: string; time: string }[];
}

interface UseVehicleStopPreviewArgs {
  /** tripId of the focused vehicle; hook returns null when absent. */
  activeTripId: null | string;
  clickedTripUpdate?: null | ParsedTripUpdate;
  clickedVehicle?: null | VehiclePosition;
  clickedVehiclePos?: null | ParsedVehiclePosition;
  routeTimetable?: null | RouteTimetable;
  stopsById?: Map<string, Stop>;
  /** How many upcoming stops to resolve for the timeline. */
  upcomingCount?: number;
}

/**
 * Resolves the display-ready stop preview (next stop, delay pill, distance and
 * upcoming stops) for a focused vehicle. Wraps `getRouteVehicleStopPreview` and
 * keeps the panels presentational. Returns null when no vehicle is focused.
 */
export function useVehicleStopPreview({
  activeTripId,
  clickedTripUpdate,
  clickedVehicle,
  clickedVehiclePos,
  routeTimetable,
  stopsById,
  upcomingCount = 4,
}: UseVehicleStopPreviewArgs): null | VehicleStopPreview {
  const { t } = useTranslation();
  const { dataDir } = useGTFSMode();
  const lastFeedUpdate = useRealtimeStore((s) => s.lastUpdate);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // `routeTimetable` is keyed by static trip IDs; `activeTripId` is a realtime
  // one. Without this the itinerary is empty on every focused vehicle.
  const timetableTripIds = useMemo(() => Object.keys(routeTimetable ?? {}), [routeTimetable]);
  const resolver = useStaticTripResolver(timetableTripIds, { dataDir });

  return useMemo(() => {
    if (!activeTripId || !stopsById) return null;

    const previewLat = clickedVehiclePos?.latitude ?? clickedVehicle?.lat ?? 0;
    const previewLon = clickedVehiclePos?.longitude ?? clickedVehicle?.lon ?? 0;

    const preview = getRouteVehicleStopPreview({
      resolver,
      routeTimetable: routeTimetable ?? undefined,
      stopsById,
      tripId: activeTripId,
      tripUpdate: clickedTripUpdate ?? undefined,
      vehicleLat: previewLat,
      vehicleLon: previewLon,
      vehiclePos: clickedVehiclePos ?? undefined,
    });

    const delaySeconds = clickedTripUpdate?.delay ?? clickedVehicle?.delay ?? null;
    const stopLabel = preview.labelKind != null ? t(`routeBar.${preview.labelKind}`) : '';
    const stopDetail = preview.stopDetail ?? '';

    // ── Primary stop time + upcoming stops ──────────────────────────────────
    let primaryStopTime: null | string = null;
    let upcomingStops: { name: string; time: string }[] = [];

    if (preview.tripStops && preview.primaryIdx !== -1) {
      const { primaryIdx, tripStops } = preview;
      primaryStopTime = formatMinutes(tripStops[primaryIdx][2], delaySeconds ?? 0);
      upcomingStops = tripStops
        .slice(primaryIdx + 1, primaryIdx + 1 + upcomingCount)
        .map(([stopId, , timeMinutes]) => ({
          name: stopsById.get(stopId)?.name ?? stopId,
          time: formatMinutes(timeMinutes, delaySeconds ?? 0),
        }))
        .filter((s) => s.name);
    } else if (clickedTripUpdate?.stopTimeUpdates && clickedTripUpdate.stopTimeUpdates.length > 0) {
      const updates = clickedTripUpdate.stopTimeUpdates;
      const currentStopId = preview.currentStopId || preview.derivedNextStopId;
      let startIndex = 0;
      if (currentStopId) {
        const idx = updates.findIndex((u) => u.stopId === currentStopId);
        if (idx !== -1) startIndex = idx;
      }

      const formatPosix = (posix?: number) => {
        if (!posix) return '—';
        const d = new Date(posix * 1000);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };

      const primaryUpdate = updates[startIndex];
      const primaryTime = primaryUpdate
        ? formatPosix(primaryUpdate.arrivalTime || primaryUpdate.departureTime)
        : null;
      primaryStopTime = primaryTime === '—' ? null : primaryTime;

      upcomingStops = updates
        .slice(startIndex + 1, startIndex + 1 + upcomingCount)
        .map((u) => ({
          name: stopsById.get(u.stopId)?.name ?? u.stopId,
          time: formatPosix(u.arrivalTime || u.departureTime),
        }))
        .filter((s) => s.name);
    }

    const first = preview.tripStops?.[0];
    const origin = first ? stopsById.get(first[0]) : undefined;
    const coords = (preview.tripStops ?? [])
      .map(([id]) => stopsById.get(id))
      .filter((s): s is Stop => !!s);
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    // The *end* anchors the service day: an overnight run can start at 23:00
    // yesterday and reach this stop after 24:00 today.
    const lastMinutes = preview.tripStops?.[preview.tripStops.length - 1]?.[2];
    if (lastMinutes !== undefined && lastMinutes >= 1440) {
      const todayEnd = midnight.getTime() + lastMinutes * 60_000;
      if (Math.abs(todayEnd - 86_400_000 - nowMs) < Math.abs(todayEnd - nowMs)) {
        midnight.setDate(midnight.getDate() - 1);
      }
    }
    const startMs = first ? midnight.getTime() + first[2] * 60_000 : undefined;
    const serviceState = clickedVehiclePos
      ? vehicleServiceState({
          feedAgeSeconds: lastFeedUpdate == null ? undefined : (nowMs - lastFeedUpdate) / 1000,
          originDistance: origin
            ? haversineMeters(previewLat, previewLon, origin.lat, origin.lon)
            : undefined,
          originProgress:
            coords.length > 1
              ? computeVehicleStopProgress(previewLat, previewLon, coords)
              : undefined,
          speed: clickedVehiclePos.speed,
          startInSeconds: startMs === undefined ? undefined : (startMs - nowMs) / 1000,
          stationarySeconds: clickedVehiclePos.stationarySeconds,
        })
      : undefined;
    const delayInfo =
      delaySeconds !== null && (!serviceState || serviceState === 'approaching')
        ? formatDelay(delaySeconds, t)
        : null;

    // ── Distance to the next stop ───────────────────────────────────────────
    const distanceTargetStop: null | Stop = (() => {
      const { currentStop, currentStopId, derivedNextStop, gpsNextStop, stopStatus, tripStops } =
        preview;
      if (gpsNextStop) return gpsNextStop;
      if (stopStatus === VehicleStopStatus.STOPPED_AT && upcomingStops.length > 0) {
        if (tripStops && currentStopId) {
          const idx = tripStops.findIndex(([id]) => id === currentStopId);
          if (idx !== -1 && idx + 1 < tripStops.length) {
            return stopsById.get(tripStops[idx + 1][0]) ?? null;
          }
        }
      }
      return currentStop ?? derivedNextStop;
    })();

    const distanceMeters =
      distanceTargetStop && previewLat && previewLon
        ? Math.round(
            haversineMeters(previewLat, previewLon, distanceTargetStop.lat, distanceTargetStop.lon)
          )
        : null;

    return {
      delayInfo,
      distanceMeters,
      primaryStopTime,
      serviceState,
      stopDetail,
      stopLabel,
      upcomingStops,
    };
  }, [
    activeTripId,
    nowMs,
    lastFeedUpdate,
    clickedTripUpdate,
    clickedVehicle,
    clickedVehiclePos,
    resolver,
    routeTimetable,
    stopsById,
    upcomingCount,
    t,
  ]);
}
