/**
 * GTFS Realtime types, parsing utilities, and fetch helpers.
 *
 * Types are copied from kreni-app-worker/src/types.ts (the Cloudflare Worker
 * proxy project) and adapted for client-side use.
 *
 * The worker at VITE_GTFS_PROXY_URL returns raw GTFS-RT protobuf binary.
 * We decode it here using the `gtfs-realtime-bindings` npm package.
 */

// gtfs-realtime-bindings is a CJS module that does `module.exports = $root`.
// In Vite's browser runtime, the entire root is exposed as the default export.
// We access transit_realtime via the namespace, falling back to .default for CJS interop.
import * as _GtfsRT from 'gtfs-realtime-bindings';
const GtfsRealtimeBindings: typeof _GtfsRT = ((_GtfsRT as any).default ??
  _GtfsRT) as typeof _GtfsRT;
import { GTFS_API_KEY, GTFS_PROXY_URL } from '../config';
import { isNative } from './platform';

/**
 * Worker query param for the ZET combined GTFS-RT protobuf (vehicles + trip updates + alerts).
 * `trip-updates` is an alias on the worker with the same upstream payload and shared cache.
 */
export const REALTIME_COMBINED_FEED_ENDPOINT = 'vehicle-positions' as const;

// ============================================
// Enums — `erasableSyntaxOnly` is enabled, so native TypeScript
// `enum` declarations are not allowed. Use const objects + type aliases.
// ============================================

export const VehicleStopStatus = {
  IN_TRANSIT_TO: 2,
  INCOMING_AT: 0,
  STOPPED_AT: 1,
} as const;
export type VehicleStopStatus = (typeof VehicleStopStatus)[keyof typeof VehicleStopStatus];

export const ScheduleRelationship = {
  NO_DATA: 2,
  SCHEDULED: 0,
  SKIPPED: 1,
} as const;
export type ScheduleRelationship = (typeof ScheduleRelationship)[keyof typeof ScheduleRelationship];

export const CongestionLevel = {
  CONGESTION: 3,
  RUNNING_SMOOTHLY: 1,
  SEVERE_CONGESTION: 4,
  STOP_AND_GO: 2,
  UNKNOWN_CONGESTION_LEVEL: 0,
} as const;
export type CongestionLevel = (typeof CongestionLevel)[keyof typeof CongestionLevel];

export const OccupancyStatus = {
  CRUSHED_STANDING_ROOM_ONLY: 4,
  EMPTY: 0,
  FEW_SEATS_AVAILABLE: 2,
  FULL: 5,
  MANY_SEATS_AVAILABLE: 1,
  NOT_ACCEPTING_PASSENGERS: 6,
  STANDING_ROOM_ONLY: 3,
} as const;
export interface FeedStatistics {
  lastUpdate?: Date;
  serviceAlerts: number;
  totalEntities: number;
  tripUpdates: number;
  vehiclePositions: number;
}

// ============================================
// Parsed types (from worker types.ts)
// ============================================

export type OccupancyStatus = (typeof OccupancyStatus)[keyof typeof OccupancyStatus];

export interface ParsedServiceAlert {
  /** POSIX start timestamp in seconds, or null */
  activeSince: null | number;
  /** POSIX end timestamp in seconds, or null */
  activeUntil: null | number;
  /** Alert cause (e.g. 'CONSTRUCTION', 'STRIKE') */
  cause: string;
  /** Date verified against original RSS text; only this may expire an RSS notice. */
  confirmedEndDate?: null | string;
  /** Long description text (Croatian preferred) */
  description: string;
  /** Alert effect (e.g. 'DETOUR', 'NO_SERVICE') */
  effect: string;
  /** Short header text (Croatian preferred) */
  header: string;
  id: string;
  /** Affected route IDs */
  routeIds: string[];
  /** Affected stop IDs — the flattened union of every platform in `stops` */
  stopIds: string[];
  /**
   * Affected stops grouped by the name the alert named them by, each carrying
   * every platform id that name resolved to. RSS alerts only — GTFS-RT informs
   * on raw stop ids with no name attached.
   */
  stops?: { ids: string[]; name: string }[];
  /** Optional URL to the original source (RSS alerts only) */
  url?: string;
}

export interface ParsedStopTimeUpdate {
  arrivalDelay?: number; // seconds
  arrivalTime?: number; // POSIX timestamp
  departureDelay?: number; // seconds
  departureTime?: number; // POSIX timestamp
  scheduleRelationship?: ScheduleRelationship;
  stopId: string;
  stopSequence?: number;
}

export interface ParsedTripUpdate {
  delay?: number; // seconds
  routeId: string;
  stopTimeUpdates: ParsedStopTimeUpdate[];
  timestamp?: number;
  tripId: string;
  vehicleId?: string;
}

export interface ParsedVehiclePosition {
  bearing?: number;
  congestionLevel?: CongestionLevel;
  currentStopId?: string;
  currentStopSequence?: number; // stop_sequence of the current/next stop from GTFS-RT
  latitude: number;
  longitude: number;
  occupancyStatus?: OccupancyStatus;
  routeId: string;
  speed?: number; // m/s
  /**
   * App-derived (not from the feed): seconds this vehicle has reported roughly the
   * same position across polls. Covers both a vehicle stuck in traffic and a frozen
   * GPS transponder — either way the position can no longer be treated as fresh motion.
   */
  stationarySeconds?: number;
  status?: VehicleStopStatus;
  timestamp: number; // POSIX timestamp
  tripId: string;
  vehicleId: string;
}

// ============================================
// Feed fetch helpers
// ============================================

export interface RealtimeFetchMetadata {
  cacheAgeSeconds: null | number;
  cacheStatus: 'HIT' | 'MISS' | null;
  fetchTimeMs: number;
  httpStatus: number;
  workerTimestamp: null | string;
}

type FeedEntity = any;

type GtfsRealtimeFeed = InstanceType<typeof GtfsRealtimeBindings.transit_realtime.FeedMessage>;

// ============================================
// Parsing utilities (adapted from worker parser.ts)
// ============================================

interface WindowWithWebFetch {
  CapacitorWebFetch?: typeof fetch;
}

/**
 * Fetch and protobuf-decode a GTFS-RT feed from the proxy worker.
 *
 * @param endpoint - Which feed to request
 * @returns Decoded protobuf FeedMessage and metadata
 * @throws Error when the proxy URL is not configured or the request fails
 */
export async function fetchRealtimeFeed(endpoint: 'trip-updates' | 'vehicle-positions'): Promise<{
  feed: GtfsRealtimeFeed;
  metadata: RealtimeFetchMetadata;
}> {
  if (!GTFS_PROXY_URL) {
    throw new Error('GTFS proxy URL is not configured. Set VITE_GTFS_PROXY_URL in your .env file.');
  }

  const url = `${GTFS_PROXY_URL}/?endpoint=${endpoint}`;
  const headers: Record<string, string> = {};
  if (GTFS_API_KEY) {
    headers['X-API-Key'] = GTFS_API_KEY;
  }

  const fetchStart = Date.now();
  const response = await feedFetch()(url, {
    cache: 'no-store', // Bypass browser cache so each poll fetches fresh data
    headers,
  });

  // Before touching the body: a WAF block is an HTML page, and decoding that as
  // a protobuf produces an error that describes the parser rather than the 403.
  if (!response.ok) {
    throw new Error(`GTFS proxy request failed: ${response.status} ${response.statusText}`);
  }

  const fetchEnd = Date.now();
  const workerTimestamp = response.headers.get('X-Timestamp');
  const rawCacheStatus = response.headers.get('X-Cache-Status');
  const cacheStatus: RealtimeFetchMetadata['cacheStatus'] =
    rawCacheStatus === 'HIT' || rawCacheStatus === 'MISS' ? rawCacheStatus : null;
  const ageHeader = response.headers.get('Age');
  const parsedAge = ageHeader != null ? Number.parseInt(ageHeader, 10) : Number.NaN;
  const cacheAgeSeconds = Number.isFinite(parsedAge) && parsedAge >= 0 ? parsedAge : null;
  const fetchTimeMs = fetchEnd - fetchStart;
  const httpStatus = response.status;

  const buffer = await response.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

  return {
    feed,
    metadata: {
      cacheAgeSeconds,
      cacheStatus,
      fetchTimeMs,
      httpStatus,
      workerTimestamp,
    },
  };
}

/**
 * Get aggregate statistics from a decoded GTFS-RT feed.
 */
export function getFeedStatistics(feed: GtfsRealtimeFeed): FeedStatistics {
  const vehiclePositions = feed.entity.filter((e: FeedEntity) => e.vehicle).length;
  const tripUpdates = feed.entity.filter((e: FeedEntity) => e.tripUpdate).length;
  const serviceAlerts = feed.entity.filter((e: FeedEntity) => e.alert).length;

  return {
    lastUpdate: feed.header.timestamp ? new Date(Number(feed.header.timestamp) * 1000) : undefined,
    serviceAlerts,
    totalEntities: feed.entity.length,
    tripUpdates,
    vehiclePositions,
  };
}

/**
 * Parse trip updates from a decoded GTFS-RT feed.
 */
export function parseTripUpdates(feed: GtfsRealtimeFeed): ParsedTripUpdate[] {
  return feed.entity
    .filter((entity: FeedEntity) => entity.tripUpdate)
    .map((entity: FeedEntity) => {
      const tripUpdate = entity.tripUpdate;
      return {
        delay: tripUpdate.delay !== undefined ? Number(tripUpdate.delay) : undefined,
        routeId: tripUpdate.trip.routeId || '',
        stopTimeUpdates: (tripUpdate.stopTimeUpdate || []).map(
          (stu: any): ParsedStopTimeUpdate => ({
            arrivalDelay: stu.arrival?.delay !== undefined ? Number(stu.arrival.delay) : undefined,
            arrivalTime: stu.arrival?.time !== undefined ? Number(stu.arrival.time) : undefined,
            departureDelay:
              stu.departure?.delay !== undefined ? Number(stu.departure.delay) : undefined,
            departureTime:
              stu.departure?.time !== undefined ? Number(stu.departure.time) : undefined,
            scheduleRelationship: stu.scheduleRelationship,
            stopId: stu.stopId || '',
            stopSequence: stu.stopSequence,
          })
        ),
        timestamp: tripUpdate.timestamp !== undefined ? Number(tripUpdate.timestamp) : undefined,
        tripId: tripUpdate.trip.tripId || '',
        vehicleId: tripUpdate.vehicle?.id,
      } satisfies ParsedTripUpdate;
    });
}

/**
 * Parse vehicle positions from a decoded GTFS-RT feed.
 */
export function parseVehiclePositions(feed: GtfsRealtimeFeed): ParsedVehiclePosition[] {
  return feed.entity
    .filter((entity: FeedEntity) => entity.vehicle?.position)
    .map((entity: FeedEntity) => {
      const vehicle = entity.vehicle;
      return {
        // Feed bearing is often 0 even when the vehicle is moving — ignore it
        bearing: undefined,
        congestionLevel: vehicle.congestionLevel,
        currentStopId: vehicle.stopId,
        currentStopSequence:
          vehicle.currentStopSequence != null ? Number(vehicle.currentStopSequence) : undefined,
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        occupancyStatus: vehicle.occupancyStatus,
        routeId: vehicle.trip?.routeId || '',
        // Feed speed is always 0 on this provider — treat as missing
        speed: vehicle.position?.speed > 0 ? vehicle.position.speed : undefined,
        status: vehicle.currentStatus,
        timestamp: Number(vehicle.timestamp) || Math.floor(Date.now() / 1000),
        tripId: vehicle.trip?.tripId || '',
        vehicleId: vehicle.vehicle?.id || entity.id,
      } satisfies ParsedVehiclePosition;
    });
}

/**
 * The fetch to use for the realtime feeds — deliberately *not* the ambient one
 * on native.
 *
 * `CapacitorHttp` is enabled globally (see capacitor.config.ts: `/data/*` is
 * unreachable without it) and replaces `window.fetch` with a shim that routes
 * through the native HTTP stack. For these feeds that is wrong twice over:
 *
 *   - Cloudflare's WAF 403s the native stack. Measured on device: a
 *     `CapacitorHttp.request` to the proxy comes back as the "Sorry, you have
 *     been blocked" HTML page, while the same URL from the WebView's own fetch
 *     succeeds. The block keys off the client, not the credentials.
 *   - The shim decodes bodies by content-type into a string, which corrupts
 *     `application/x-protobuf` even when the request does get through.
 *
 * The bridge stashes the untouched implementation on `window.CapacitorWebFetch`
 * before patching, so use that: a real WebView request that the WAF accepts,
 * with correct binary handling. CORS is satisfied — the Worker answers
 * `https://localhost` and allowlists `X-API-Key` on the preflight, unlike the
 * `/data` origin, which is why only these feeds can go this way.
 */
function feedFetch(): typeof fetch {
  if (!isNative()) return fetch;
  const preserved = (window as unknown as WindowWithWebFetch).CapacitorWebFetch;
  return typeof preserved === 'function' ? preserved.bind(window) : fetch;
}

/**
 * Extract text from a GTFS-RT TranslatedString.
 * Prefers Croatian ('hr'), falls back to first translation.
 */
function getTranslatedText(ts: any): string {
  if (!ts?.translation?.length) return '';
  const hr = ts.translation.find((t: { language?: string; text?: string }) => t.language === 'hr');
  return (hr ?? ts.translation[0])?.text ?? '';
}

const CAUSE_LABELS: Record<number, string> = {
  1: 'UNKNOWN_CAUSE',
  2: 'OTHER_CAUSE',
  3: 'TECHNICAL_PROBLEM',
  4: 'STRIKE',
  5: 'DEMONSTRATION',
  6: 'ACCIDENT',
  7: 'HOLIDAY',
  8: 'WEATHER',
  9: 'MAINTENANCE',
  10: 'CONSTRUCTION',
  11: 'POLICE_ACTIVITY',
  12: 'MEDICAL_EMERGENCY',
};

const EFFECT_LABELS: Record<number, string> = {
  1: 'NO_SERVICE',
  2: 'REDUCED_SERVICE',
  3: 'SIGNIFICANT_DELAYS',
  4: 'DETOUR',
  5: 'ADDITIONAL_SERVICE',
  6: 'MODIFIED_SERVICE',
  7: 'OTHER_EFFECT',
  8: 'UNKNOWN_EFFECT',
  9: 'STOP_MOVED',
};

export interface VehicleSnapshot {
  /** Position of the last time the vehicle moved ≥ STATIONARY_RADIUS_METERS (stationary anchor) */
  anchorLat?: number;
  anchorLon?: number;
  /** Wall-clock ms when the stationary anchor was last reset (vehicle last moved) */
  anchorWallMs?: number;
  /** Bearing carried across polls to prevent arrows from disappearing on cache hits */
  bearing?: number;
  latitude: number;
  longitude: number;
  /** EMA-smoothed derived speed carried across polls (m/s) */
  smoothedSpeed?: number;
  /** POSIX seconds */
  timestamp: number;
}

// ============================================
// Display helpers (from worker parser.ts)
// ============================================

/**
 * Bearing in degrees (0 = North, clockwise) from point 1 → point 2.
 */
export function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Enrich a vehicle position with derived bearing and/or speed by comparing
 * it against a previous snapshot.
 *
 * Rules:
 * - Time delta must be 3 s – 300 s (avoid noise & stale data)
 * - Movement must be ≥ 5 m (below GPS noise threshold)
 * - Derived speed capped at 33 m/s (~120 km/h)
 * - Derived values only fill in missing fields from the feed
 * - Speed is EMA-smoothed across polls (instantaneous position deltas jitter too much
 *   to drive a stable ETA countdown)
 */
export function enrichWithDeadReckoning(
  current: ParsedVehiclePosition,
  prev: VehicleSnapshot
): ParsedVehiclePosition {
  const dt = current.timestamp - prev.timestamp; // seconds

  // If time delta is too small (e.g. cache hit) or too large (stale), we can't derive new motion.
  // But we MUST carry over the previous bearing so the arrow doesn't disappear.
  if (dt < 3 || dt > 300) {
    return {
      ...current,
      bearing: prev.bearing,
      speed: prev.smoothedSpeed,
    };
  }

  const dist = haversineDistance(
    prev.latitude,
    prev.longitude,
    current.latitude,
    current.longitude
  );

  // GPS noise — vehicle likely stationary. Keep previous bearing.
  if (dist < 5) {
    return {
      ...current,
      bearing: prev.bearing,
      speed: prev.smoothedSpeed,
    };
  }

  const derivedBearing = computeBearing(
    prev.latitude,
    prev.longitude,
    current.latitude,
    current.longitude
  );
  const rawSpeed = Math.min(dist / dt, 33); // m/s, capped at ~120 km/h
  const derivedSpeed =
    prev.smoothedSpeed !== undefined ? 0.4 * rawSpeed + 0.6 * prev.smoothedSpeed : rawSpeed;

  return {
    ...current,
    // Always prefer derived bearing — feed value is unreliable/zero
    bearing: derivedBearing,
    // Always prefer derived speed — feed speed is always 0 on this provider
    speed: derivedSpeed,
  };
}

// ============================================
// Dead-reckoning: derive bearing + speed from
// consecutive position snapshots.
// ============================================

/**
 * Format delay in a human-readable way.
 *
 * @param delaySeconds - Delay in seconds (negative = early, positive = late)
 */
export function formatDelay(delaySeconds?: number): string {
  if (delaySeconds === undefined) return '';

  const absDelay = Math.abs(delaySeconds);

  if (absDelay < 60) {
    return 'On time';
  }

  const minutes = Math.round(absDelay / 60);
  const status = delaySeconds > 0 ? 'kasni' : 'prerano';

  return `${minutes} min ${status}`;
}

/** Haversine distance in metres between two WGS-84 coordinates. */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // Earth radius in metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parse service alerts from a decoded GTFS-RT feed.
 */
export function parseServiceAlerts(feed: GtfsRealtimeFeed): ParsedServiceAlert[] {
  return feed.entity
    .filter((entity: FeedEntity) => entity.alert)
    .map((entity: FeedEntity): ParsedServiceAlert => {
      const alert = entity.alert;
      const informed: any[] = alert.informedEntity || [];
      const routeIds = informed
        .map((e: { routeId?: string }) => e.routeId)
        .filter((id): id is string => !!id);
      const stopIds = informed
        .map((e: { stopId?: string }) => e.stopId)
        .filter((id): id is string => !!id);

      // Active period — take the first one if multiple
      const period: any = alert.activePeriod?.[0] ?? null;

      const effect = EFFECT_LABELS[Number(alert.effect)] ?? 'UNKNOWN_EFFECT';
      const header = getTranslatedText(alert.headerText);

      return {
        activeSince: period?.start ? Number(period.start) : null,
        activeUntil: period?.end ? Number(period.end) : null,
        cause: CAUSE_LABELS[Number(alert.cause)] ?? 'UNKNOWN_CAUSE',
        description: getTranslatedText(alert.descriptionText),
        effect,
        header,
        // Content-addressed when the feed omits an entity id. It used to fall
        // back to Math.random(), which minted a new id for the same alert on
        // every poll: React saw a different key each time and remounted the
        // card, so effect colours visibly jumped around mid-session.
        id: entity.id || `rt-${effect}-${routeIds.join('.')}-${stopIds.join('.')}-${header}`,
        routeIds,
        stopIds,
      };
    });
}

/**
 * Convert speed from m/s to km/h.
 */
export function speedToKmh(speedMs?: number): number | undefined {
  return speedMs !== undefined ? Math.round(speedMs * 3.6 * 10) / 10 : undefined;
}
