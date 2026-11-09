/**
 * Unified route + vehicle panel (the fixed top-left card in GTFS mode).
 *
 * A single reactive card whose content is a pure function of two facts passed in:
 *  - `activeTripId` — is a vehicle focused?
 *  - `isFollowing`  — is the map locked to it?
 *
 * States:
 *  1. Browse (no `activeTripId`)          — the whole line of stops (same metro
 *     diagram as `RouteViewLarge`) with every vehicle on it, plus a direction
 *     toggle and the no-vehicles banner
 *  2. Focused (`activeTripId`)            — the vehicle's itinerary (next stops)
 */

import {
  ArrowRight,
  Bus,
  CalendarOff,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  MapPin,
  Maximize2,
  Navigation,
  Star,
  Train,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Route, RouteTimetable, Stop } from '../../../utils/gtfs';
import type {
  ParsedServiceAlert,
  ParsedTripUpdate,
  ParsedVehiclePosition,
} from '../../../utils/realtime';
import type { VehiclePosition } from '../../../utils/vehicles';

import { useGTFSMode } from '../../../contexts/GTFSModeContext';
import { useStaticTripResolver } from '../../../hooks/useStaticTripResolver';
import { useStopDepartures } from '../../../hooks/useStopDepartures';
import { useSettingsStore } from '../../../stores/settingsStore';
import { exceptionalJourneyEnd } from '../../../utils/journeyDestination';
import { isNightRoute } from '../../../utils/nightLines';
import { getRouteSuspension, parseFeedDate } from '../../../utils/routeService';
import { routeBadgeColor } from '../../../utils/routeStyle';
import { getDirectionColor } from '../../Map/directionColors';
import { DepartureCard } from '../DepartureCard';
import { NightMoon } from '../NightMoon';
import { RouteDirectionHeader } from '../RouteDirectionHeader';
import { RouteStopList } from '../RouteStopList';
import { ServiceAlertBanner } from '../ServiceAlertBanner';
import { FocusedVehicleCard } from './FocusedVehicleCard';

const DATE_FMT = new Intl.DateTimeFormat('hr-HR', { day: 'numeric', month: 'short' });

interface RouteVehiclePanelProps {
  activeTripId: null | string;
  clickedTripUpdate?: null | ParsedTripUpdate;
  clickedVehicle?: null | VehiclePosition;
  clickedVehiclePos?: null | ParsedVehiclePosition;
  isFollowing: boolean;
  /** Direction key ('0'/'1') to pre-select and lock when coming from Plan Journey. */
  journeyDirectionKey?: null | string;
  journeyFromParentId?: null | string;
  journeyToParentId?: null | string;
  loading?: boolean;
  /** Return to the Plan Journey results this route was opened from. */
  onBackToJourney?: () => void;
  onClose: () => void;
  onExpand: () => void;
  onFollowStart: (tripId: string) => void;
  /** Open the stop view for a stop picked off the line. */
  onStopClick: (stopId: string) => void;
  onStopFollowing: () => void;
  /** Focus a vehicle picked off the line, switching the card to its itinerary. */
  onVehicleClick: (tripId: string) => void;
  orderedStops?: Record<string, string[]>;
  route: Route;
  /** ZET alerts naming this route — shown once a vehicle is focused. */
  routeAlerts?: ParsedServiceAlert[];
  routesById?: Map<string, Route>;
  routeTimetable?: null | RouteTimetable;
  stopsById?: Map<string, Stop>;
  timetableLoading?: boolean;
  vehicles: VehiclePosition[];
}

export function RouteVehiclePanel({
  activeTripId,
  clickedTripUpdate,
  clickedVehicle,
  clickedVehiclePos,
  isFollowing,
  journeyDirectionKey,
  journeyFromParentId,
  journeyToParentId,
  loading = false,
  onBackToJourney,
  onClose,
  onExpand,
  onFollowStart,
  onStopClick,
  onStopFollowing,
  onVehicleClick,
  orderedStops,
  route,
  routeAlerts,
  routesById,
  routeTimetable,
  stopsById,
  timetableLoading = false,
  vehicles,
}: RouteVehiclePanelProps) {
  const { t } = useTranslation();
  const { dataDir } = useGTFSMode();
  const tripIds = useMemo(() => Object.keys(routeTimetable ?? {}), [routeTimetable]);
  const tripResolver = useStaticTripResolver(tripIds, { dataDir });
  const staticTripId = activeTripId ? tripResolver.resolve(activeTripId) : undefined;
  const exceptionalEnd = exceptionalJourneyEnd(
    staticTripId ? routeTimetable?.[staticTripId] : undefined,
    orderedStops,
    stopsById,
    clickedVehicle?.headsign
  );
  const color = routeBadgeColor(route);
  const RouteIcon = route.type === 3 ? Bus : Train;
  const { favouriteRouteIds, toggleFavouriteRoute } = useSettingsStore();
  const isFav = favouriteRouteIds.includes(route.id);
  // Why the line looks dead: it is out of service for a stretch, not just idle.
  const suspension = getRouteSuspension(route, new Date());

  const [compactListDirectionKey, setCompactListDirectionKey] = useState('');
  const [showOriginDepartures, setShowOriginDepartures] = useState(false);

  const directionKeysSorted = useMemo(
    () => (orderedStops ? Object.keys(orderedStops).sort((a, b) => Number(a) - Number(b)) : []),
    [orderedStops]
  );

  useEffect(() => {
    if (directionKeysSorted.length === 0) return;
    setCompactListDirectionKey(() => {
      if (journeyDirectionKey && directionKeysSorted.includes(journeyDirectionKey)) {
        return journeyDirectionKey;
      }
      return directionKeysSorted[0];
    });
  }, [directionKeysSorted, journeyDirectionKey, route.id]);

  /** Vehicles in the active direction; if none match, fall back to all of them. */
  const vehiclesInDirection = useMemo(() => {
    if (vehicles.length === 0) return [];
    if (!orderedStops || directionKeysSorted.length === 0 || !stopsById) return vehicles;
    const directionIndex =
      compactListDirectionKey && directionKeysSorted.includes(compactListDirectionKey)
        ? directionKeysSorted.indexOf(compactListDirectionKey)
        : 0;
    const dirVehicles = vehicles.filter((v) => v.direction === directionIndex);
    return dirVehicles.length > 0 ? dirVehicles : vehicles;
  }, [compactListDirectionKey, directionKeysSorted, orderedStops, vehicles, stopsById]);

  const journeySegment = useMemo(() => {
    if (!journeyFromParentId || !journeyToParentId || !stopsById) return null;
    const ids = orderedStops?.[compactListDirectionKey] ?? [];
    const fromIdx = ids.findIndex((id) => stopsById.get(id)?.parentStation === journeyFromParentId);
    let toIdx = -1;
    for (let i = ids.length - 1; i >= 0; i--) {
      if (stopsById.get(ids[i])?.parentStation === journeyToParentId) {
        toIdx = i;
        break;
      }
    }
    if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) return null;
    return { fromIdx, toIdx };
  }, [journeyFromParentId, journeyToParentId, compactListDirectionKey, orderedStops, stopsById]);

  const showHeadsignInsteadOfRouteName =
    !!activeTripId && !!clickedVehicle?.headsign && clickedVehicle.headsign !== route.longName;

  const activeKey = compactListDirectionKey || directionKeysSorted[0] || '';
  const directionStopIds = orderedStops?.[activeKey] ?? [];
  const hasDirections = !!orderedStops && !!stopsById && directionKeysSorted.length > 0;

  /** Terminus name + colour per direction — drives the compact direction toggle. */
  const directionLabels = useMemo(
    () =>
      directionKeysSorted.map((key, idx) => {
        const ids = orderedStops?.[key] ?? [];
        const endId = ids[ids.length - 1] ?? ids[0] ?? null;
        return {
          color: getDirectionColor(route.type ?? null, idx),
          key,
          label: (endId ? stopsById?.get(endId)?.name : null) ?? key,
        };
      }),
    [directionKeysSorted, orderedStops, route.type, stopsById]
  );
  const activeDirection = directionLabels[directionKeysSorted.indexOf(activeKey)];

  /** Step to the next direction of the line (two on ZET lines, but cycle anyway). */
  const switchDirection = () => {
    if (directionKeysSorted.length < 2) return;
    const idx = directionKeysSorted.indexOf(activeKey);
    setCompactListDirectionKey(directionKeysSorted[(idx + 1) % directionKeysSorted.length]);
  };

  // Boarding stop of the journey — its departures can be expanded inline for
  // schedule context, especially when no live vehicles are tracked.
  const originStopId =
    journeySegment && routesById ? (directionStopIds[journeySegment.fromIdx] ?? null) : null;
  const originStopName = originStopId ? stopsById?.get(originStopId)?.name : undefined;

  // Anchored exactly like StopInfoBar: a flat `top-16` ignores the status-bar
  // inset, so on Android the card rode up into the search / journey / locate /
  // spider buttons instead of starting below them.
  return (
    <div
      className="fixed top-[calc(4rem+env(safe-area-inset-top))] sm:top-[calc(5rem+env(safe-area-inset-top))] left-2 right-2 sm:left-4 sm:right-auto sm:max-w-md z-[1150] bg-base-100 rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[calc(100dvh-5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:max-h-[calc(100dvh-6rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
      style={{ animation: 'modal-fade-in 0.2s ease-out' }}
    >
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto overscroll-contain p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {onBackToJourney && (
              <button
                className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px] shrink-0"
                onClick={onBackToJourney}
                title={t('routeBar.backToResults')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <span
              className="badge font-bold text-white shrink-0 min-w-[2.5rem] justify-center"
              style={{ backgroundColor: color, borderColor: color }}
            >
              {route.shortName}
              {isNightRoute(route) && <NightMoon />}
            </span>
            <h3 className="font-bold text-base leading-tight text-base-content truncate flex items-center gap-1 min-w-0">
              {showHeadsignInsteadOfRouteName ? (
                <>
                  <ArrowRight
                    aria-hidden
                    className="w-4 h-4 shrink-0 text-base-content/60 self-center"
                    strokeWidth={2.5}
                  />
                  <span className="truncate">{clickedVehicle?.headsign}</span>
                </>
              ) : (
                route.longName
              )}
            </h3>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px]"
              onClick={() => toggleFavouriteRoute(route.id)}
              title={isFav ? t('search.favouriteRemove') : t('search.favouriteAdd')}
            >
              <Star
                className="w-4 h-4"
                color={isFav ? '#f59e0b' : 'currentColor'}
                fill={isFav ? '#f59e0b' : 'none'}
              />
            </button>
            {activeTripId && (
              <button
                className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px]"
                onClick={() => (isFollowing ? onStopFollowing() : onFollowStart(activeTripId))}
                title={isFollowing ? t('common.stopFollowingVehicle') : t('common.followVehicle')}
              >
                <Navigation className={`w-4 h-4${isFollowing ? ' text-info' : ''}`} />
              </button>
            )}
            <button
              className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px]"
              onClick={onExpand}
              title={t('common.showRouteDetails')}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px]"
              onClick={onClose}
              title={t('common.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {suspension && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 mb-3 rounded-lg border border-warning/30 bg-warning/10">
            <CalendarOff className="w-4 h-4 shrink-0 text-warning" />
            <span className="text-xs font-medium text-base-content/70">
              {t('routeBar.suspendedBanner', {
                date: DATE_FMT.format(parseFeedDate(suspension.until)),
              })}
            </span>
          </div>
        )}

        {/* Alerts sit above the body so they read the same whether you are
            browsing the line or watching one vehicle on it. */}
        {routesById && (
          <ServiceAlertBanner
            alerts={routeAlerts ?? []}
            className="mb-3"
            compact
            routesById={routesById}
          />
        )}

        {/* Body */}
        {hasDirections ? (
          <div className="space-y-2">
            {journeySegment && (
              <div className="flex flex-col gap-1 px-3 py-2 rounded-lg border border-primary/25 bg-primary/5">
                <div className="flex items-center gap-2">
                  <Navigation className="w-3.5 h-3.5 shrink-0 text-primary/70" />
                  <span className="text-xs text-base-content/70">
                    {t('routeBar.journeySegmentLabel', {
                      from: stopsById?.get(directionStopIds[journeySegment.fromIdx])?.name ?? '',
                      to: stopsById?.get(directionStopIds[journeySegment.toIdx])?.name ?? '',
                    })}
                  </span>
                </div>
                {vehiclesInDirection.length > 0 && (
                  <span className="text-[10px] text-base-content/50 pl-[22px]">
                    {t('routeBar.catchableVehiclesHint')}
                  </span>
                )}
              </div>
            )}

            {activeTripId ? (
              <>
                {exceptionalEnd && (
                  <p className="px-3 py-2 text-xs text-base-content/70">
                    {t('routeBar.endsAt', { name: exceptionalEnd })}
                  </p>
                )}
                <FocusedVehicleCard
                  activeTripId={activeTripId}
                  clickedTripUpdate={clickedTripUpdate}
                  clickedVehicle={clickedVehicle}
                  clickedVehiclePos={clickedVehiclePos}
                  color={color}
                  routeTimetable={routeTimetable}
                  stopsById={stopsById}
                  timetableLoading={timetableLoading}
                />
              </>
            ) : (
              <>
                {vehiclesInDirection.length === 0 && (
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-warning/30 bg-warning/10">
                    <RouteIcon className="w-4 h-4 shrink-0 text-warning" />
                    <span className="text-xs font-medium text-base-content/70">
                      {t('routeBar.noActiveVehiclesBanner')}
                    </span>
                  </div>
                )}

                {/* Direction header — the journey context pins the direction */}
                {!journeySegment && activeDirection && (
                  <RouteDirectionHeader
                    caption={t('routeBar.directionTowards')}
                    color={activeDirection.color}
                    label={activeDirection.label}
                    onSwitch={directionLabels.length > 1 ? switchDirection : undefined}
                  />
                )}

                {/* The line of stops — same diagram as the expanded route view */}
                {/* Capped well under the panel's own height so the banners, the
                    direction header and the departures below stay reachable
                    without the panel itself having to scroll. */}
                <div className="max-h-[32vh] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-base-300">
                  <RouteStopList
                    journeySegment={journeySegment}
                    onStopClick={onStopClick}
                    onVehicleClick={onVehicleClick}
                    orderedStopIds={directionStopIds}
                    routeType={route.type}
                    segmentColor={activeDirection?.color ?? color}
                    stopsById={stopsById}
                    vehicles={vehiclesInDirection}
                  />
                </div>

                {vehiclesInDirection.length > 0 && (
                  <p className="text-[10px] text-base-content/35 text-center">
                    {t('routeBar.tapVehiclesHint')}
                  </p>
                )}
              </>
            )}

            {originStopId && stopsById && routesById && (
              <div>
                <button
                  aria-expanded={showOriginDepartures}
                  className="btn btn-sm btn-block justify-start gap-2 border border-base-300 font-normal btn-ghost"
                  onClick={() => setShowOriginDepartures((v) => !v)}
                  type="button"
                >
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 truncate text-left text-xs">
                    {t('routeBar.viewDeparturesHere', { stop: originStopName })}
                  </span>
                  {showOriginDepartures ? (
                    <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                  )}
                </button>
                {showOriginDepartures && (
                  <div className="mt-1.5">
                    <OriginDeparturesSection
                      dataDir={dataDir}
                      routesById={routesById}
                      stopId={originStopId}
                      stopsById={stopsById}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <div className="skeleton h-3 w-3/4 rounded" />
            <div className="skeleton h-3 w-1/2 rounded" />
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-base-content/60">
            <RouteIcon className="w-3.5 h-3.5 shrink-0" />
            <span>{t('routeBar.noActiveVehicles')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline departures board for the journey's boarding stop, rendered *inside* the
 * route panel (no separate overlay). Isolated as its own component so the 1s
 * clock tick only re-renders this section, not the whole panel.
 */
function OriginDeparturesSection({
  dataDir,
  routesById,
  stopId,
  stopsById,
}: {
  dataDir: string;
  routesById: Map<string, Route>;
  stopId: string;
  stopsById: Map<string, Stop>;
}) {
  const { t } = useTranslation();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { departures, loading } = useStopDepartures(stopId, routesById, stopsById, nowMs, {
    dataDir,
  });
  const top = departures.slice(0, 4);

  if (loading && departures.length === 0) {
    return (
      <p className="px-1 py-1 text-[11px] text-base-content/50">{t('stopView.loadingTimetable')}</p>
    );
  }
  if (top.length === 0) {
    return (
      <p className="px-1 py-1 text-[11px] text-base-content/50">
        {t('stopView.noDeparturesInMins', { minutes: 60 })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {top.map((dep) => (
        <DepartureCard compact departure={dep} key={dep.tripId} />
      ))}
      {departures.length > top.length && (
        <span className="px-1 text-[11px] text-base-content/50">
          {t('stopView.seeAllCount', { count: departures.length })}
        </span>
      )}
    </div>
  );
}
