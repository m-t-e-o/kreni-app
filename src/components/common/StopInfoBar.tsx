/**
 * Fixed stop info bar at the top — tabbed view with "Vozila" (live GPS) and "Red vožnje" (timetable).
 */

import { ArrowRight, Maximize2, Navigation2, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Route, Stop } from '../../utils/gtfs';
import type { ParsedServiceAlert } from '../../utils/realtime';

import { useGTFSMode } from '../../contexts/GTFSModeContext';
import { useSiblingPlatformRoutes } from '../../hooks/useSiblingPlatformRoutes';
import { useStopDepartures } from '../../hooks/useStopDepartures';
import { useStopRoutes } from '../../hooks/useStopRoutes';
import { useStopTermini } from '../../hooks/useStopTermini';
import { useSettingsStore } from '../../stores/settingsStore';
import { bearingToCompassKey } from '../../utils/gtfs';
import { compassLabelForBearing } from '../../utils/localizedCompass';
import { isNightRoute } from '../../utils/nightLines';
import { routeBadgeColor } from '../../utils/routeStyle';
import { DepartureCard } from './DepartureCard';
import { NightMoon } from './NightMoon';
import { ServiceAlertBanner } from './ServiceAlertBanner';

interface StopInfoBarProps {
  /** When set, narrows the board to a planned trip's routes and shows a banner. */
  journeyFilter?: null | { fromName: string; routeIds: string[]; toName: string };
  onClearJourneyFilter?: () => void;
  onClose: () => void;
  onExpand: (stopId: string) => void;
  onRouteClick?: (
    routeId: string,
    routeType: number,
    tripId?: string,
    lat?: null | number,
    lon?: null | number
  ) => void;
  onStopSelect?: (stopId: string) => void;
  routesById: Map<string, Route>;
  /** When true, shifts the bar down so it sits below the RouteVehiclePanel */
  stackBelow?: boolean;
  stop: Stop;
  /** ZET service alerts affecting this stop (shown as a warning banner). */
  stopAlerts?: ParsedServiceAlert[];
  stopsById: Map<string, Stop>;
}

export function StopInfoBar({
  journeyFilter,
  onClearJourneyFilter,
  onClose,
  onExpand,
  onRouteClick,
  onStopSelect,
  routesById,
  stackBelow = false,
  stop,
  stopAlerts,
  stopsById,
}: StopInfoBarProps) {
  const { t } = useTranslation();
  const { dataDir, timetableLookaheadMinutes } = useGTFSMode();
  const { favouriteStopIds, toggleFavouriteStop } = useSettingsStore();
  const isFav = favouriteStopIds.includes(stop.id);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [routesExpanded, setRoutesExpanded] = useState(false);

  const ROUTES_COLLAPSED_MAX = 3;

  // 1-second tick for live countdown
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const {
    departures,
    isAllTerminus,
    loading: departuresLoading,
  } = useStopDepartures(stop.id, routesById, stopsById, nowMs, {
    dataDir,
    lookaheadMinutes: timetableLookaheadMinutes,
  });

  // Sibling platforms — stops at the same parent station, or (fallback) same-named stops
  // when no parent station is set (common for bus stop pairs without GTFS grouping).
  // Parent-station siblings: deduplicated by code (each platform code is unique).
  // Same-name fallback siblings: deduplicated by bearing direction (typically 2 opposite platforms).
  const siblingPlatforms: Stop[] = (() => {
    if (stop.parentStation !== null) {
      return Array.from(stopsById.values()).filter(
        (s) => s.locationType === 0 && s.parentStation === stop.parentStation && s.id !== stop.id
      );
    }
    const raw = Array.from(stopsById.values()).filter(
      (s) =>
        s.locationType === 0 &&
        s.id !== stop.id &&
        s.name === stop.name &&
        (stop.routeType === undefined ||
          s.routeType === undefined ||
          s.routeType === stop.routeType)
    );
    const seen = new Set<string>();
    return raw.filter((s) => {
      const key = s.bearing !== undefined ? bearingToCompassKey(s.bearing) : (s.code ?? s.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  // Fetch routes for each sibling platform so we can show route badges
  const { routeMap: siblingRouteMap } = useSiblingPlatformRoutes(
    siblingPlatforms.map((s) => s.id),
    routesById,
    { dataDir }
  );

  // Filter sibling platforms that actually have departures (for terminus banner)
  const departingSiblings = siblingPlatforms.filter((s) => {
    const routes = siblingRouteMap.get(s.id);
    return routes && routes.length > 0;
  });

  const terminusBanner = isAllTerminus ? (
    <div className="rounded-lg bg-warning/10 border border-warning/30 p-3 mt-1">
      <p className="text-xs font-semibold text-warning mb-1">{t('stopView.terminusTitle')}</p>
      <p className="text-xs text-base-content/70 mb-2">
        {t('stopView.terminusBody')}
        {departingSiblings.length > 0 && ` ${t('stopView.terminusPickPlatform')}`}
      </p>
      {departingSiblings.map((s) => {
        const routes = siblingRouteMap.get(s.id) ?? [];
        const maxBadges = 6;
        return (
          <button
            className="btn btn-xs btn-warning w-full gap-1.5 mt-1 flex-wrap justify-start"
            key={s.id}
            onClick={() => onStopSelect?.(s.id)}
            type="button"
          >
            <ArrowRight className="w-3 h-3 shrink-0" />
            <span>{t('stopView.terminalButton')}</span>
            {routes.length > 0 && (
              <span className="flex flex-wrap gap-0.5 ml-1">
                {routes.slice(0, maxBadges).map((r) => (
                  <span className="badge badge-xs font-bold badge-ghost opacity-80" key={r.id}>
                    {r.shortName}
                    {isNightRoute(r) && <NightMoon className="w-2.5 h-2.5" />}
                  </span>
                ))}
                {routes.length > maxBadges && (
                  <span className="text-xs opacity-60">+{routes.length - maxBadges}</span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  ) : null;

  // When arriving from a planned trip, keep only the journey's routes.
  const relevantDepartures = journeyFilter
    ? departures.filter((d) => journeyFilter.routeIds.includes(d.routeId))
    : departures;
  const topDepartures = relevantDepartures.slice(0, 4);

  const { routes: stopRoutes } = useStopRoutes(stop.id, routesById, { dataDir });
  const { termini } = useStopTermini(stop.id, stopsById, routesById, { dataDir });

  return (
    <div
      className={`fixed left-2 right-2 sm:left-4 sm:right-auto sm:max-w-md z-[1150] bg-base-100 rounded-xl shadow-2xl flex flex-col overflow-hidden ${
        stackBelow
          ? 'top-[calc(11rem+env(safe-area-inset-top))] max-h-[calc(100dvh-12rem-env(safe-area-inset-top))]'
          : 'top-[calc(4rem+env(safe-area-inset-top))] sm:top-[calc(5rem+env(safe-area-inset-top))] max-h-[calc(100dvh-5rem-env(safe-area-inset-top))] sm:max-h-[calc(100dvh-6rem-env(safe-area-inset-top))]'
      }`}
      data-testid="stop-info-panel"
      style={{ animation: 'modal-fade-in 0.2s ease-out' }}
    >
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto overscroll-contain p-4">
        {/* Header */}
        <div className="mb-2">
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 flex-1 min-w-0">
              <h3 className="font-bold text-base leading-tight text-base-content">{stop.name}</h3>
              {stopRoutes.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  {(routesExpanded ? stopRoutes : stopRoutes.slice(0, ROUTES_COLLAPSED_MAX)).map(
                    (route) =>
                      onRouteClick ? (
                        <button
                          className="badge badge-sm font-bold text-white cursor-pointer hover:opacity-75 transition-opacity"
                          key={route.id}
                          onClick={() => onRouteClick(route.id, route.type)}
                          style={{ backgroundColor: routeBadgeColor(route) }}
                          type="button"
                        >
                          {route.shortName}
                          {isNightRoute(route) && <NightMoon />}
                        </button>
                      ) : (
                        <span
                          className="badge badge-sm font-bold text-white"
                          key={route.id}
                          style={{ backgroundColor: routeBadgeColor(route) }}
                        >
                          {route.shortName}
                          {isNightRoute(route) && <NightMoon />}
                        </span>
                      )
                  )}
                  {!routesExpanded && stopRoutes.length > ROUTES_COLLAPSED_MAX && (
                    <button
                      className="badge badge-sm badge-ghost font-semibold cursor-pointer hover:badge-neutral"
                      onClick={() => setRoutesExpanded(true)}
                      type="button"
                    >
                      +{stopRoutes.length - ROUTES_COLLAPSED_MAX}
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                className="btn btn-ghost btn-circle btn-xs"
                onClick={() => toggleFavouriteStop(stop.id)}
                title={isFav ? t('search.favouriteRemove') : t('search.favouriteAdd')}
              >
                <Star
                  className="w-4 h-4"
                  color={isFav ? '#f59e0b' : 'currentColor'}
                  fill={isFav ? '#f59e0b' : 'none'}
                />
              </button>
              <button
                className="btn btn-ghost btn-circle btn-xs"
                onClick={() => onExpand(stop.id)}
                title={t('common.showDetails')}
              >
                <Maximize2 className="w-4 h-4" />
              </button>
              <button
                className="btn btn-ghost btn-circle btn-xs"
                onClick={onClose}
                title={t('common.close')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          {!isAllTerminus && (stop.bearing !== undefined || stop.code) && (
            <div className="text-xs text-base-content/60 flex items-center gap-1">
              <span>
                {stop.bearing !== undefined
                  ? termini.length > 0
                    ? t('search.headingTowards', { place: termini.join(', ') })
                    : t('search.headingTowards', { place: compassLabelForBearing(stop.bearing, t) })
                  : t('search.headingCode', { code: stop.code ?? '' })}
              </span>
            </div>
          )}
        </div>

        {/* Service-alert banner (disruptions affecting this stop) */}
        {stopAlerts && stopAlerts.length > 0 && (
          <ServiceAlertBanner
            alerts={stopAlerts}
            className="mb-2"
            compact
            routesById={routesById}
          />
        )}

        {/* Planned-trip filter banner */}
        {journeyFilter && (
          <div className="mb-2 p-2 rounded-lg bg-primary/10 border border-primary/30 flex gap-1.5 items-center">
            <Navigation2 className="w-3.5 h-3.5 text-primary shrink-0" />
            <p className="flex-1 min-w-0 text-xs text-base-content/80">
              {t('stopView.journeyFilterNotice', {
                from: journeyFilter.fromName,
                to: journeyFilter.toName,
              })}
            </p>
            <button
              className="btn btn-ghost btn-circle btn-xs shrink-0"
              onClick={onClearJourneyFilter}
              title={t('common.close')}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Unified departure board */}
        {departuresLoading ? (
          <div className="flex items-center gap-2 py-2">
            <span className="loading loading-spinner loading-sm" />
            <span className="text-sm text-base-content/60">{t('stopView.loadingTimetable')}</span>
          </div>
        ) : topDepartures.length === 0 ? (
          (terminusBanner ?? (
            <div className="text-sm text-base-content/50 py-2 text-center">
              {t('stopView.noDeparturesInMins', { minutes: timetableLookaheadMinutes })}
            </div>
          ))
        ) : (
          <div className="space-y-2">
            {topDepartures.map((dep) => (
              <DepartureCard departure={dep} key={dep.tripId} onRouteClick={onRouteClick} />
            ))}
            {relevantDepartures.length > topDepartures.length && (
              <button
                className="w-full text-xs text-base-content/50 hover:text-base-content/80 py-1 text-center transition-colors"
                onClick={() => onExpand(stop.id)}
                type="button"
              >
                {t('stopView.seeAllCount', { count: relevantDepartures.length })} →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
