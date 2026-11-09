/**
 * A single row in the unified stop departure board.
 *
 * Trust is encoded in the format of the time itself, not in labels:
 *   - Live rows (GPS-tracked): green "~N min" countdown with a pulsing dot next to the
 *     number, expected clock time below. Minutes are the precision floor — the feed pings
 *     every 10–20 s, so a seconds countdown would claim accuracy we don't have.
 *   - Scheduled rows: a plain muted clock time is the hero ("a promise from paper"),
 *     with an "in N min" helper only when imminent. No dot, no subtitle.
 *   - Passed rows: dimmed "Prošao" — informative "you just missed it".
 */

import type { TFunction } from 'i18next';

import { Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { StopDeparture } from '../../hooks/useStopDepartures';

import { formatTime24h } from '../../utils/gtfs';
import { isNightRoute } from '../../utils/nightLines';
import { NIGHT_ROUTE_COLOR } from '../../utils/routeStyle';
import { NightMoon } from './NightMoon';

/** Show the "in N min" helper on scheduled rows when departure is within this window */
const SCHEDULED_IMMINENT_SECONDS = 600;

interface DepartureCardProps {
  /** Compact single-row style for StopInfoBar; default false = full card for StopModal */
  compact?: boolean;
  departure: StopDeparture;
  onRouteClick?: (
    routeId: string,
    routeType: number,
    tripId: string,
    lat: null | number,
    lon: null | number
  ) => void;
}

export function DepartureCard({ compact = false, departure, onRouteClick }: DepartureCardProps) {
  const { t } = useTranslation();
  const {
    adjustedMinutes,
    delaySeconds,
    distanceMeters,
    etaSeconds,
    gpsArrivalMinutes,
    gpsStale,
    hasGps,
    passedStop,
    realtimeSource,
    scheduledMinutes,
  } = departure;

  const hasDelay = realtimeSource !== null && delaySeconds !== null;
  const delaySec = delaySeconds ?? 0;
  const isLate = hasDelay && delaySec > 90;
  const isEarly = hasDelay && delaySec < -90;
  const isLive = hasGps && !passedStop;
  const isAtStop = isLive && distanceMeters !== null && distanceMeters < 15;

  const isNight = isNightRoute({ shortName: departure.routeShortName });
  const badgeColor = isNight
    ? NIGHT_ROUTE_COLOR
    : departure.routeType === 0
      ? '#2563eb'
      : '#d97706';
  // Expected clock time (delay-adjusted when realtime data exists); wraps after midnight
  const clockTime = formatTime24h(hasDelay ? adjustedMinutes : scheduledMinutes);

  // ── Right-hand block ──
  let primaryText: string;
  let primaryColor: string;
  let secondary: null | string = null;
  const secondaryColor = 'text-base-content/40';

  if (passedStop) {
    primaryText = t('vehicleCard.passed');
    primaryColor = 'text-base-content/40';
    secondary = clockTime;
  } else if (isLive) {
    // Ceil, not round: the straight-line ETA already errs early and red lights push
    // reality later — under-promising trains users to distrust the green numbers.
    const mins = Math.max(1, Math.ceil(etaSeconds / 60));
    primaryText = isAtStop ? t('vehicleCard.atStop') : t('vehicleCard.minutesTilde', { mins });
    primaryColor = 'text-success';
    // Live countdown and clock must describe the same GPS estimate. The scheduled
    // clock can differ by many minutes on depot trips or stale trip-level delays.
    secondary = formatTime24h(gpsArrivalMinutes);
  } else {
    // Scheduled-only: the clock time is the hero
    primaryText = clockTime;
    primaryColor = isLate ? 'text-error' : isEarly ? 'text-success' : 'text-base-content/80';
    if (etaSeconds < SCHEDULED_IMMINENT_SECONDS) {
      secondary =
        etaSeconds < 60
          ? t('timetableCard.departsNow')
          : t('timetableCard.inMinutes', { count: Math.round(etaSeconds / 60) });
    }
  }

  // ── Subtitle: proximity fact for tracked rows only; scheduled rows stay clean ──
  // Kept even under the "na stajalištu" hero: metres there read as "5 m", which confirms
  // the hero rather than repeating it — unlike the old label, which just said it twice.
  const liveProximity = isLive ? proximityLabel(departure, t) : null;
  const subtitle = passedStop ? (
    <div className="text-[11px] text-base-content/45 leading-tight flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
      <span className="truncate">{t('vehicleCard.passedStop')}</span>
    </div>
  ) : liveProximity ? (
    <div className="text-[11px] text-base-content/45 leading-tight">
      <span className="truncate">{liveProximity}</span>
    </div>
  ) : null;

  const badge = (
    <span
      className={`badge ${compact ? 'badge-sm' : ''} font-bold ${
        compact ? 'min-w-[2.5rem]' : 'min-w-[2.75rem]'
      } justify-center shrink-0 text-white`}
      style={{
        backgroundColor: badgeColor,
        ...(isAtStop ? { animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite' } : {}),
      }}
    >
      {departure.routeShortName}
      {isNight && <NightMoon />}
    </span>
  );

  // A green navigation icon sits next to the countdown — colour + motion mark realtime rows
  const liveDot = isLive ? (
    <Navigation
      aria-hidden="true"
      className={`w-3 h-3 shrink-0 text-success ${gpsStale ? '' : 'animate-pulse'}`}
    />
  ) : null;

  const destination = onRouteClick ? (
    <button
      className={`${compact ? 'text-xs' : 'text-sm font-medium'} truncate leading-tight text-left hover:opacity-70 transition-opacity w-full block`}
      onClick={() =>
        onRouteClick(
          departure.routeId,
          departure.routeType,
          departure.tripId,
          departure.lat,
          departure.lon
        )
      }
      type="button"
    >
      {departure.tripDestinationName}
    </button>
  ) : (
    <div className={`${compact ? 'text-xs' : 'text-sm font-medium'} truncate leading-tight`}>
      {departure.tripDestinationName}
    </div>
  );

  const dimClass = passedStop ? 'opacity-50' : '';

  const rightBlock = (
    <div className="text-right shrink-0">
      <div
        className={`font-bold text-sm tabular-nums whitespace-nowrap flex items-center justify-end gap-1.5 ${primaryColor}`}
      >
        <span>{primaryText}</span>
        {liveDot}
      </div>
      {secondary !== null && (
        <div className={`mt-0.5 text-[11px] tabular-nums ${secondaryColor}`}>{secondary}</div>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className={`flex items-center gap-2 ${dimClass}`}>
        {badge}
        <div className="flex-1 min-w-0">
          {destination}
          {subtitle}
        </div>
        {rightBlock}
      </div>
    );
  }

  return (
    <div className={`card ${isAtStop ? 'bg-success/10' : 'bg-base-200'} ${dimClass}`}>
      <div className="card-body p-3 gap-0">
        <div className="flex items-center gap-2">
          {badge}
          <div className="flex-1 min-w-0">
            {destination}
            {subtitle !== null && <div className="mt-0.5">{subtitle}</div>}
          </div>
          {rightBlock}
        </div>
      </div>
    </div>
  );
}

/**
 * Format distance: metres below 1000, km above. Rounded coarsely on purpose — the feed
 * pings every 10–20 s and GPS jitters, so "187 m" would claim precision we don't have,
 * the same reasoning that puts a minutes floor on the countdown. Rounding happens before
 * the km cutover so 980 m reads as "1.0 km" rather than "1000 m".
 */
function formatDistance(meters: number, t: TFunction): string {
  const rounded =
    meters < 100 ? Math.max(10, Math.round(meters / 10) * 10) : Math.round(meters / 50) * 50;
  if (rounded < 1000) return t('common.metresShort', { metres: rounded });
  return t('common.kilometres', { km: (rounded / 1000).toFixed(1) });
}

/**
 * Proximity fact for live rows, picked so each range shows the signal that is actually
 * trustworthy there. Stops-away leads while the vehicle is still stops out: it survives
 * red lights that stall the minute estimate. Inside the last stop it stops discriminating
 * — 0 covers everything from the platform to the whole inter-stop link — and that is
 * exactly where straight-line distance is most accurate, so metres take over. Metres also
 * remain the fallback when stop topology is unavailable; with neither, the row stays clean.
 */
function proximityLabel(d: StopDeparture, t: TFunction): null | string {
  if (d.stopsAway !== null && d.stopsAway > 0) {
    return t('vehicleCard.stopsAway', { count: d.stopsAway });
  }
  if (d.distanceMeters !== null) {
    return t('vehicleCard.distanceAway', { distance: formatDistance(d.distanceMeters, t) });
  }
  return null;
}
