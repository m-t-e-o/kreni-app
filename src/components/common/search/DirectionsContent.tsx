import { ArrowRight, ChevronRight, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Route, Stop } from '../../../utils/gtfs';
import type { TransitJourneyTime } from '../../../utils/transitJourneyTime';
import type { AllVehiclePosition } from '../../../utils/vehicles';

import { useGTFSMode } from '../../../contexts/GTFSModeContext';
import { useCurrentTime } from '../../../hooks/useCurrentTime';
import { useJourneyDepartures } from '../../../hooks/useJourneyDepartures';
import { useRouteTripDirections } from '../../../hooks/useRouteTripDirections';
import { useTransitJourneyTimes } from '../../../hooks/useTransitJourneyTimes';
import { fetchRouteStops } from '../../../utils/gtfs';
import { isNightRoute, isNightTime } from '../../../utils/nightLines';
import { RouteBadge } from '../RouteBadge';
import { RouteMiniTrack } from '../RouteMiniTrack';

export interface JourneyStopFilter {
  fromName: string;
  routeIds: string[];
  toName: string;
}

interface DirectionResult {
  directionFilter: 'A' | 'B';
  directionKey: string;
  fromIndex: number;
  parentStopIds: string[];
  route: Route;
  stopsBetween: number;
  toIndex: number;
}

interface DirectionResultRowProps {
  dataDir: string;
  /** Night line shown during the day — see dimNightLines in DirectionsContent. */
  dimNight: boolean;
  fromName: string;
  item: DirectionResult;
  journeyRouteIds: string[];
  onSelectJourneyStop: (childStopId: string, filter: JourneyStopFilter) => void;
  stopsById: Map<string, Stop>;
  timing?: null | TransitJourneyTime;
  timingLoading?: boolean;
  toName: string;
  vehicles: AllVehiclePosition[];
}

interface DirectionsContentProps {
  dirFromStop: null | Stop;
  dirLoading: boolean;
  dirResultLabel: string;
  dirResults: DirectionResult[];
  dirToStop: null | Stop;
  onSelectDirectionsRoute: (
    routeId: string,
    routeType: number,
    direction: 'A' | 'B',
    tripId?: null | string
  ) => void;
  /** Tapping a transit result jumps to the boarding platform's stop view, filtered to the journey. */
  onSelectJourneyStop: (childStopId: string, filter: JourneyStopFilter) => void;
  stopsById: Map<string, Stop>;
  vehicles: AllVehiclePosition[];
}

export function DirectionsContent({
  dirFromStop,
  dirLoading,
  dirResultLabel,
  dirResults,
  dirToStop,
  onSelectDirectionsRoute,
  onSelectJourneyStop,
  stopsById,
  vehicles,
}: DirectionsContentProps) {
  const { t } = useTranslation();
  const { dataDir, hasRealtime } = useGTFSMode();

  // Night lines are always offered — planning tomorrow's way home is a daytime
  // activity — but during the day they are dimmed so they don't read as an
  // option you could board now.
  const dimNightLines = !isNightTime(useCurrentTime());

  // Every direct route that makes this journey — the departure board at the
  // boarding stop is narrowed to these once a result is tapped.
  const journeyRouteIds = useMemo(
    () => [...new Set(dirResults.map((r) => r.route.id))],
    [dirResults]
  );

  // Train mode: show a chronological A→B departures board (times + duration)
  // instead of a bare list of connecting lines.
  const showDepartureBoard = !hasRealtime;
  const { directionByRoute, routeIds, routesById } = useMemo(() => {
    const ids = new Set<string>();
    const byId = new Map<string, Route>();
    const dir = new Map<string, 'A' | 'B'>();
    for (const r of dirResults) {
      ids.add(r.route.id);
      byId.set(r.route.id, r.route);
      if (!dir.has(r.route.id)) dir.set(r.route.id, r.directionFilter);
    }
    return { directionByRoute: dir, routeIds: [...ids], routesById: byId };
  }, [dirResults]);

  const { departures: journeyDepartures, loading: journeyLoading } = useJourneyDepartures(
    showDepartureBoard ? (dirFromStop?.id ?? null) : null,
    showDepartureBoard ? (dirToStop?.id ?? null) : null,
    routeIds,
    routesById,
    dataDir
  );
  const { loading: timesLoading, times } = useTransitJourneyTimes(
    hasRealtime ? routeIds : [],
    hasRealtime ? (dirFromStop?.id ?? null) : null,
    hasRealtime ? (dirToStop?.id ?? null) : null,
    stopsById,
    dataDir
  );
  const timedResults = [...dirResults].sort(
    (a, b) =>
      (times.get(a.route.id)?.departureMs ?? Infinity) -
      (times.get(b.route.id)?.departureMs ?? Infinity)
  );

  if (dirFromStop && dirToStop && showDepartureBoard) {
    const loading = dirLoading || journeyLoading;
    return (
      <div className="p-4 space-y-3">
        <div aria-live="polite" className="text-xs text-base-content/60 px-1">
          {loading
            ? t('search.searchingDirectRoutes')
            : journeyDepartures.length === 0
              ? t('search.noDirectTrains')
              : t('search.trainsFound', { count: journeyDepartures.length })}
        </div>
        {loading && (
          <div className="flex items-center gap-2 text-sm text-base-content/60 px-1">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('search.loading')}
          </div>
        )}
        {!loading && journeyDepartures.length > 0 && (
          <div className="divide-y divide-base-300 border border-base-300 rounded-xl overflow-hidden">
            {journeyDepartures.map((d) => {
              const direction = directionByRoute.get(d.route.id) ?? 'A';
              return (
                <button
                  className="w-full px-3 py-3 text-left hover:bg-base-200 transition-colors flex items-center gap-3"
                  key={d.instanceId}
                  onClick={() =>
                    onSelectDirectionsRoute(d.route.id, d.route.type, direction, d.instanceId)
                  }
                  type="button"
                >
                  <div className="flex items-center gap-1.5 font-bold tabular-nums shrink-0">
                    <span>{fmtTime(d.depMin)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-base-content/40" />
                    <span>{fmtTime(d.arrMin)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-base-content/60 truncate">{d.route.longName}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-base-content/50 tabular-nums">
                      {fmtDuration(d.durationMin)}
                    </span>
                    <RouteBadge
                      className="badge-sm"
                      dimmed={dimNightLines && isNightRoute(d.route)}
                      label={d.trainNumber || undefined}
                      route={d.route}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (dirFromStop && dirToStop) {
    return (
      <div className="p-4 space-y-3">
        <div aria-live="polite" className="text-xs text-base-content/60 px-1">
          {dirResultLabel}
        </div>
        {dirLoading && (
          <div className="flex items-center gap-2 text-sm text-base-content/60 px-1">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('search.loading')}
          </div>
        )}
        {!dirLoading && dirResults.length === 0 && (
          <div className="text-center text-base-content/50 py-4 text-sm">
            {t('search.noDirectRoutes')}
          </div>
        )}
        {!dirLoading && dirResults.length > 0 && (
          <div className="divide-y divide-base-300 border border-base-300 rounded-xl overflow-hidden">
            {timedResults.map((item) => (
              <DirectionResultRow
                dataDir={dataDir}
                dimNight={dimNightLines && isNightRoute(item.route)}
                fromName={dirFromStop?.name ?? ''}
                item={item}
                journeyRouteIds={journeyRouteIds}
                key={`${item.route.id}-${item.directionKey}`}
                onSelectJourneyStop={onSelectJourneyStop}
                stopsById={stopsById}
                timing={times.get(item.route.id)}
                timingLoading={timesLoading}
                toName={dirToStop?.name ?? ''}
                vehicles={vehicles}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}

/**
 * One direction result: the clickable route header plus a mini-track showing the
 * journey segment and any live vehicles heading that way.
 *
 * The realtime feed gives no direction, so a route's live vehicles arrive
 * undifferentiated. We resolve each vehicle's real direction from the route's
 * trip index (keyed by tripId) and keep only those going this result's way —
 * otherwise every result would show its route's vehicles from both directions,
 * or (as before) only the "A" direction ever matched. The index is fetched only
 * when the route actually has live vehicles to place.
 *
 * Tapping the result (header or a vehicle) resolves the boarding platform and
 * hands off to the stop view, filtered to the journey's routes.
 */
function DirectionResultRow({
  dataDir,
  dimNight,
  fromName,
  item,
  journeyRouteIds,
  onSelectJourneyStop,
  stopsById,
  timing,
  timingLoading,
  toName,
  vehicles,
}: DirectionResultRowProps) {
  const { i18n, t } = useTranslation();

  const candidateVehicles = useMemo(
    () => vehicles.filter((v) => v.routeId === item.route.id),
    [vehicles, item.route.id]
  );

  const tripDirections = useRouteTripDirections(
    item.route.id,
    candidateVehicles.length > 0,
    dataDir
  );

  // route_parent_stops direction keys are the GTFS direction_id, matching the
  // trip index's `direction` field.
  const wantDirection = Number(item.directionKey);
  const routeVehicles = useMemo(
    () => candidateVehicles.filter((v) => tripDirections.get(v.tripId) === wantDirection),
    [candidateVehicles, tripDirections, wantDirection]
  );

  const journeySegment = { fromIdx: item.fromIndex, toIdx: item.toIndex };
  const terminusName = stopsById.get(item.parentStopIds[item.parentStopIds.length - 1])?.name;

  const goToBoardingStop = async () => {
    const childStopId = await resolveBoardingPlatform(item, stopsById, dataDir);
    onSelectJourneyStop(childStopId, { fromName, routeIds: journeyRouteIds, toName });
  };

  return (
    <div>
      {/* Route info row — clickable header */}
      <button
        className="w-full px-3 pt-3 pb-2 text-left hover:bg-base-200 transition-colors"
        onClick={goToBoardingStop}
        type="button"
      >
        <div className={`flex items-center gap-3 ${dimNight ? 'opacity-60' : ''}`}>
          <RouteBadge
            className="min-w-[3rem] justify-center"
            dimmed={dimNight}
            route={item.route}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm line-clamp-1">{item.route.longName}</div>
            <div className="text-xs text-base-content/60">
              {terminusName
                ? t('search.routeTerminusMeta', {
                    count: item.stopsBetween + 1,
                    place: terminusName,
                  })
                : t('search.routeDirectionMeta', {
                    count: item.stopsBetween + 1,
                    direction: item.directionFilter,
                  })}
            </div>
            <p aria-live="polite" className="mt-1 text-xs text-base-content/75">
              {timingLoading
                ? t('search.loading')
                : timing
                  ? t('search.scheduledJourney', {
                      arrival: new Date(timing.arrivalMs).toLocaleString(
                        i18n.resolvedLanguage || i18n.language,
                        {
                          hour: '2-digit',
                          hour12: false,
                          minute: '2-digit',
                          weekday: 'short',
                        }
                      ),
                      departure: new Date(timing.departureMs).toLocaleString(
                        i18n.resolvedLanguage || i18n.language,
                        {
                          hour: '2-digit',
                          hour12: false,
                          minute: '2-digit',
                          weekday: 'short',
                        }
                      ),
                    })
                  : t('search.scheduleUnavailable')}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-base-content/30 shrink-0" />
        </div>
      </button>

      {/* Mini track — tapping a vehicle also opens the boarding stop view */}
      {item.parentStopIds.length >= 2 && (
        <div className="px-3 pb-3">
          <RouteMiniTrack
            expanded={false}
            journeySegment={journeySegment}
            onVehicleClick={goToBoardingStop}
            orderedStopIds={item.parentStopIds}
            routeType={item.route.type}
            stopsById={stopsById}
            vehicles={routeVehicles}
          />
          {routeVehicles.length === 0 && (
            <div className="mt-1 text-center text-[11px] text-base-content/45">
              {t('search.noLiveVehiclesHint')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Format a duration in minutes as e.g. "2h 15m" or "45m". */
function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Format minutes-from-midnight as HH:MM (wraps past-midnight times). */
function fmtTime(min: number): string {
  const w = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
}

/**
 * The origin parent may have several platforms; the one this route+direction
 * actually departs from is the exact stop to send the user to. We match the
 * origin parent against the direction's platform-level stop list. A parent can
 * appear more than once on loop/branch routes, so ties break to the occurrence
 * nearest the boarding index. Falls back to any child platform of the parent,
 * then the parent id itself.
 */
async function resolveBoardingPlatform(
  item: DirectionResult,
  stopsById: Map<string, Stop>,
  dataDir: string
): Promise<string> {
  const originParent = item.parentStopIds[item.fromIndex];
  const parentOf = (platformId: string) => stopsById.get(platformId)?.parentStation ?? platformId;
  try {
    const platforms = (await fetchRouteStops(item.route.id, dataDir)).orderedStops?.[
      item.directionKey
    ];
    const candidates = (platforms ?? []).filter((p) => parentOf(p) === originParent);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && platforms) {
      const ratio =
        item.parentStopIds.length > 1 ? item.fromIndex / (item.parentStopIds.length - 1) : 0;
      const target = ratio * (platforms.length - 1);
      return candidates.reduce((best, c) =>
        Math.abs(platforms.indexOf(c) - target) < Math.abs(platforms.indexOf(best) - target)
          ? c
          : best
      );
    }
  } catch {
    // fall through to the parent-scan fallback
  }
  for (const s of stopsById.values()) {
    if (s.locationType === 0 && s.parentStation === originParent) return s.id;
  }
  return originParent;
}
