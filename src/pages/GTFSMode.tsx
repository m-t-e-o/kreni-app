/**
 * Unified GTFS transit page, shared between Public-Transport (bus/tram) and
 * Train modes.  All mode-specific behaviour is controlled by the
 * GTFSModeConfig that is injected via props and published on GTFSModeContext
 * so that leaf components (StopInfoBar, StopModal) can read dataDir without
 * prop-drilling.
 */

// `Route` is aliased: the bare name is the GTFS domain type everywhere else.
import { Route as RouteIcon, Search, Train, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RealtimeStatusPanelHandle } from '../components/common/RealtimeStatusPanel';
import type { GTFSModeConfig } from '../config/modes';
import type { DirectionFilter } from '../hooks/useSelectionParams';
import type { ParsedServiceAlert } from '../utils/realtime';

import { DebugPanel } from '../components/common/DebugPanel';
import { DirectionsModal } from '../components/common/DirectionsModal';
import { DisruptionsPanel } from '../components/common/disruptions/DisruptionsPanel';
import { NearbyStopsModal } from '../components/common/NearbyStopsModal';
import { NightMoon } from '../components/common/NightMoon';
import { OnboardingWizard } from '../components/common/OnboardingWizard';
import { RealtimeStatusPanel } from '../components/common/RealtimeStatusPanel';
import { RouteVehiclePanel } from '../components/common/routePanel/RouteVehiclePanel';
import { RouteViewLarge } from '../components/common/RouteViewLarge';
import { SearchModal } from '../components/common/SearchModal';
import { StopInfoBar } from '../components/common/StopInfoBar';
import { StopModal } from '../components/common/StopModal';
import { MapView } from '../components/Map/MapView';
import { MAP_ZOOM_TRANSIT_STOPS_HINT_THRESHOLD } from '../components/Map/mapZoomConstants';
import { GTFSModeProvider } from '../contexts/GTFSModeContext';
import { useAlertIndexes } from '../hooks/useAlertIndexes';
import { useAllVehiclePositions } from '../hooks/useAllVehiclePositions';
import { useCongestionData } from '../hooks/useCongestionData';
import { useCurrentService } from '../hooks/useCurrentService';
import { useGeolocation, useRegisterGeolocationFirstFix } from '../hooks/useGeolocation';
import { useInitialData } from '../hooks/useInitialData';
import { useMapPanTarget } from '../hooks/useMapPanTarget';
import { useRealtimeData } from '../hooks/useRealtimeData';
import { useRoadClosures } from '../hooks/useRoadClosures';
import { useRouteData } from '../hooks/useRouteData';
import { useRouteTimetable } from '../hooks/useRouteTimetable';
import { useRssServiceAlerts } from '../hooks/useRssServiceAlerts';
import { useSelectionParams } from '../hooks/useSelectionParams';
import { useVehicleFollow } from '../hooks/useVehicleFollow';
import { useVehiclePositions } from '../hooks/useVehiclePositions';
import { useNavigationStore } from '../stores/navigationStore';
import { useRealtimeStore } from '../stores/realtimeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { trackEvent } from '../utils/analytics';
import { getMockServiceAlerts } from '../utils/devMockServiceAlerts';
import { isNightRoute } from '../utils/nightLines';
import { routeBadgeColor } from '../utils/routeStyle';

interface GTFSModeProps {
  config: GTFSModeConfig;
}

/** Stable empty-array identity for stops with no alerts (avoids re-renders). */
const EMPTY_ALERTS: ParsedServiceAlert[] = [];

export function GTFSMode({ config }: GTFSModeProps) {
  const { t } = useTranslation();
  // Modal states
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [directionsModalOpen, setDirectionsModalOpen] = useState(false);
  const [routeViewLargeOpen, setRouteViewLargeOpen] = useState(false);
  const [stopModalOpen, setStopModalOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [nearbyStopsListExpanded, setNearbyStopsListExpanded] = useState(false);
  const [journeyContext, setJourneyContext] = useState<null | {
    fromParentId: string;
    toParentId: string;
  }>(null);
  // When set, the Plan Journey modal re-opens pre-filled with these stops
  // (used to return from a route detail back to the results list).
  const [directionsRestore, setDirectionsRestore] = useState<null | {
    fromParentId: string;
    toParentId: string;
  }>(null);
  // When arriving at a stop from a planned trip: narrows the stop's departure
  // board to the journey's routes and shows a banner. Scoped to `stopId` so it
  // auto-clears if the user switches to a different platform.
  const [stopJourneyFilter, setStopJourneyFilter] = useState<null | {
    fromName: string;
    routeIds: string[];
    stopId: string;
    toName: string;
  }>(null);

  const setNearbyPanelOpen = useCallback((open: boolean) => {
    setNearbyOpen(open);
    if (!open) {
      setNearbyStopsListExpanded(false);
    }
  }, []);

  const realtimePanelRef = useRef<RealtimeStatusPanelHandle>(null);

  /** Close the "tehnički detalji" popover when user performs other actions (stop click, location, etc.) */
  const closeLegendAndDetails = useCallback(() => {
    realtimePanelRef.current?.closeLegends();
  }, []);

  // URL-backed selection state (route, stop, direction)
  const {
    clearRoute,
    clearStop,
    directionFilter,
    selectedRouteId,
    selectedStopId,
    selectRoute,
    selectStop,
  } = useSelectionParams();

  const mapZoom = useSettingsStore((s) => s.mapZoom);
  const sandboxVisible = useSettingsStore((s) => s.sandboxVisible);
  const { addRecentRoute, addRecentStop } = useSettingsStore();

  const showCongestionHeatmap = false; // useSettingsStore((s) => s.showCongestionHeatmap);

  // Load initial data from the mode's data directory
  const {
    calendar,
    error: initialError,
    loading: initialLoading,
    routes,
    routesById,
    stops,
    stopsById,
  } = useInitialData({ dataDir: config.dataDir });

  // Separate parent stations and platform stops for zoom-based rendering.
  // Memoized so these keep a stable identity across renders (they only depend on
  // the static `stops` data) — otherwise every render hands MapView fresh arrays
  // and defeats its React.memo.
  const parentStations = useMemo(() => stops.filter((stop) => stop.locationType === 1), [stops]);
  const platformStops = useMemo(() => stops.filter((stop) => stop.locationType === 0), [stops]);

  const parentChildCounts = useMemo(() => {
    const counts = new Map<string, number>();
    parentStations.forEach((parent) => {
      counts.set(parent.id, platformStops.filter((s) => s.parentStation === parent.id).length);
    });
    return counts;
  }, [parentStations, platformStops]);

  const {
    handleSelectStop,
    handleSelectStopFromNearby,
    handleStopClickFromMap,
    handleZoomComplete,
    parentStationZoomTarget,
    setParentStationZoomTarget,
  } = useMapPanTarget({
    addRecentStop,
    closeLegendAndDetails,
    config,
    selectStop,
    setNearbyOpen: setNearbyPanelOpen,
    stops,
    stopsById,
  });

  const { previousServiceId, serviceId } = useCurrentService(calendar);

  // Load route-specific data
  const {
    activeTripsData,
    loading: routeLoading,
    orderedStops,
    routeStops,
    shapes,
  } = useRouteData(selectedRouteId, { dataDir: config.dataDir });

  // Load per-trip stop sequence + times for the "next stops" feature
  const { data: routeTimetable, loading: timetableLoading } = useRouteTimetable(
    selectedRouteId,
    config.dataDir
  );

  // Scheduled vehicle positions (transit only; null activeTripsData yields [])
  const vehicles = useVehiclePositions(
    config.hasRealtime ? selectedRouteId : null,
    config.hasRealtime ? activeTripsData : null,
    serviceId,
    previousServiceId
  );

  // Realtime GTFS-RT polling (no-op when disabled)
  const {
    error: _realtimeError,
    loading: realtimeLoading,
    nextPollAtMs,
    stats: realtimeStats,
  } = useRealtimeData(config.hasRealtime);
  const gtfsRtAlerts = useRealtimeStore((s) => s.serviceAlerts);
  const lastUpdate = useRealtimeStore((s) => s.lastUpdate);
  const workerTimestamp = useRealtimeStore((s) => s.workerTimestamp);
  const cacheStatus = useRealtimeStore((s) => s.cacheStatus);
  const cacheAgeSeconds = useRealtimeStore((s) => s.cacheAgeSeconds);
  const fetchLatencyMs = useRealtimeStore((s) => s.fetchLatencyMs);
  const vehiclePositions = useRealtimeStore((s) => s.vehiclePositions);
  const tripUpdates = useRealtimeStore((s) => s.tripUpdates);

  const {
    focusVehicle,
    followedTripUpdate,
    followedVehicleParsedPos,
    followedVehiclePos,
    handleFollowStart,
    handleStopFollowing,
    vehicleFocus,
    zoomToRouteTrigger,
  } = useVehicleFollow(selectedRouteId, vehiclePositions, tripUpdates);

  // RSS-parsed ZET service alerts (polled by GitHub Actions cron every 30 min).
  // `stops` lets the hook resolve each alert's affectedStops names → GTFS stop ids.
  const { alerts: rssAlerts, pastAlerts } = useRssServiceAlerts(routesById, stops);
  // getMockServiceAlerts returns [] unless VITE_MOCK_ALERTS=true (dev only)
  const serviceAlerts = useMemo(
    () => [...getMockServiceAlerts(routesById, stops), ...rssAlerts, ...gtfsRtAlerts],
    [routesById, stops, rssAlerts, gtfsRtAlerts]
  );

  const { alertsByRouteId, alertsByStopId, alertStopIds } = useAlertIndexes(
    serviceAlerts,
    stopsById
  );

  // Road closures overlay + list (transit view only; `enabled` gates the fetch)
  const isTransit = config.id === 'transit';
  const {
    closures: roadClosures,
    loading: closuresLoading,
    manualRefreshLocked: closuresRefreshLocked,
    manualRefreshSecondsLeft: closuresRefreshSecondsLeft,
    refetch: refetchClosures,
    refreshedAtMs: closuresRefreshedAtMs,
  } = useRoadClosures(isTransit);

  // Congestion heatmap (tram-only, transit mode only)
  const { congestionPoints } = useCongestionData({
    enabled: config.hasRealtime && showCongestionHeatmap,
    routesById,
    stopsById,
  });

  // All-vehicles overlay (transit only)
  const { vehicles: allVehicles } = useAllVehiclePositions(
    config.hasRealtime,
    serviceId,
    routesById
  );

  const selectedRouteType = selectedRouteId
    ? (routesById.get(selectedRouteId)?.type ?? null)
    : null;

  // Geolocation
  const onLocateSuccess = useCallback(
    (_lat: number, _lon: number) => {
      clearStop();
      closeLegendAndDetails();
      setNearbyOpen(true);
      setNearbyStopsListExpanded(false);
    },
    [clearStop, closeLegendAndDetails]
  );
  useRegisterGeolocationFirstFix(onLocateSuccess);
  const { locateError, userLocation } = useGeolocation();

  const triggerLocate = useNavigationStore((s) => s.triggerLocate);
  const requestMapFlyTo = useNavigationStore((s) => s.requestMapFlyTo);
  const prevNearbyListExpandedRef = useRef(false);

  /** After expanding the nearby list on mobile, re-fly so the user marker clears the sheet. */
  useEffect(() => {
    if (!nearbyOpen || !userLocation) {
      prevNearbyListExpandedRef.current = nearbyStopsListExpanded;
      return;
    }
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    if (!isMobile) {
      prevNearbyListExpandedRef.current = nearbyStopsListExpanded;
      return;
    }
    if (nearbyStopsListExpanded && !prevNearbyListExpandedRef.current) {
      triggerLocate();
    }
    prevNearbyListExpandedRef.current = nearbyStopsListExpanded;
  }, [nearbyOpen, nearbyStopsListExpanded, userLocation, triggerLocate]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSelectRoute = (
    routeId: string,
    _routeType: number,
    df?: 'all' | DirectionFilter,
    tripId?: null | string,
    fromParentId?: null | string,
    toParentId?: null | string,
    follow: boolean = false
  ) => {
    let dir: DirectionFilter = df === 'A' || df === 'B' ? df : 'A';

    if (!df && tripId) {
      const vehicle =
        vehicles.find((v) => v.tripId === tripId) || allVehicles.find((v) => v.tripId === tripId);
      if (vehicle) {
        dir = vehicle.direction === 1 ? 'B' : 'A';
      }
    }

    if (tripId) {
      trackEvent('vehicle_clicked', { route_id: routeId, trip_id: tripId });
    }
    selectRoute(routeId, { dir });
    setSearchModalOpen(false);
    closeLegendAndDetails();
    addRecentRoute(routeId);
    if (tripId) focusVehicle(tripId, { follow, routeId });
    setRouteViewLargeOpen(false);
    setStopModalOpen(false);
    if (fromParentId && toParentId) {
      setJourneyContext({ fromParentId, toParentId });
    } else {
      setJourneyContext(null);
    }
  };

  const handleExpandStop = (stopId: string) => {
    closeLegendAndDetails();
    const stop = stopsById.get(stopId);
    const targetId =
      stop && stop.locationType === 1
        ? (stops.find((s) => s.parentStation === stopId && s.locationType === 0)?.id ?? stopId)
        : stopId;
    // Keep the planned-trip filter only when expanding the same journey stop.
    if (stopJourneyFilter?.stopId !== targetId) setStopJourneyFilter(null);
    selectStop(targetId);
    addRecentStop(stopId);
    setStopModalOpen(true);
  };

  // Plan-trip result tapped: jump the stop view to the boarding platform and
  // narrow its board to the journey's routes (replaces the old route overlay).
  const handleSelectJourneyStop = (
    childStopId: string,
    filter: { fromName: string; routeIds: string[]; toName: string }
  ) => {
    closeLegendAndDetails();
    setDirectionsModalOpen(false);
    setDirectionsRestore(null);
    clearRoute();
    setJourneyContext(null);
    selectStop(childStopId);
    addRecentStop(childStopId);
    setStopJourneyFilter({ ...filter, stopId: childStopId });
    // Land on the compact stop bar, not the expanded modal.
    setStopModalOpen(false);
  };

  /**
   * A stop tapped on the route's line diagram. Zooms the map to it like any
   * other stop selection — on mobile the marker is pushed into the lower half,
   * since the stop bar that replaces this panel covers the top of the screen.
   */
  const handleStopClickFromRoute = (stopId: string) => {
    handleSelectStop(stopId);
    setRouteViewLargeOpen(false);
  };

  /** A vehicle tapped on the route's line diagram — same landing as tapping it on the map. */
  const handleVehicleClickFromRoute = (tripId: string) => {
    closeLegendAndDetails();
    focusVehicle(tripId);
    setRouteViewLargeOpen(false);
  };

  const handleRouteClickFromStop = (
    routeId: string,
    routeType: number,
    tripId?: string,
    lat?: null | number,
    lon?: null | number
  ) => {
    if (tripId) {
      handleSelectRoute(routeId, routeType, undefined, tripId);
    } else {
      selectRoute(routeId);
      setStopModalOpen(false);
      setRouteViewLargeOpen(false);
    }
    if (lat != null && lon != null) {
      const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
      setParentStationZoomTarget({
        lat,
        lon,
        panOffsetY: isMobile ? -Math.round(window.innerHeight / 4) : 0,
        zoom: 16,
      });
    }
  };

  const handleExpandRoute = () => setRouteViewLargeOpen(true);
  const handleCloseRoute = () => setRouteViewLargeOpen(false);
  const handleClearRoute = () => clearRoute();

  const handleCloseStop = () => {
    setStopModalOpen(false);
    setStopJourneyFilter(null);
  };

  const handleCloseStopInfo = () => {
    clearStop();
    setStopJourneyFilter(null);
  };

  // Open the Plan Journey modal fresh (no restored stops).
  const openPlanJourney = () => {
    setDirectionsRestore(null);
    setDirectionsModalOpen(true);
  };

  // Return from a route detail to the Plan Journey results, restoring the
  // origin/destination that produced this route.
  const handleBackToJourney = () => {
    if (journeyContext) setDirectionsRestore(journeyContext);
    handleClearRoute();
    setDirectionsModalOpen(true);
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const activeHighlightStopIds = useMemo(
    () => (selectedRouteId && routeStops ? routeStops : []),
    [selectedRouteId, routeStops]
  );

  // Cross-link from the disruptions panel: pan + pulse the map to an alert's
  // affected stops (they are already amber-badged by the marker layer).
  const handleAlertStopHighlight = useCallback(
    (stopIds: string[]) => {
      let sumLat = 0;
      let sumLng = 0;
      let count = 0;
      for (const id of stopIds) {
        const stop = stopsById.get(id);
        if (stop) {
          sumLat += stop.lat;
          sumLng += stop.lon;
          count += 1;
        }
      }
      if (count === 0) return;
      // Zoom must exceed MAP_ZOOM_TRANSIT_STOPS_HINT_THRESHOLD (15) or transit stops
      // render at opacity 0 — otherwise we'd pan to invisible stops.
      requestMapFlyTo({ lat: sumLat / count, lng: sumLng / count, pulseMs: 2500, zoom: 16 });
    },
    [stopsById, requestMapFlyTo]
  );

  // Stable handler identities so MapView's React.memo isn't defeated by fresh
  // inline arrows each render. onVehicleClick goes through a ref because
  // handleSelectRoute is recreated every render; the ref keeps the callback
  // identity constant while always invoking the latest handleSelectRoute.
  const handleSelectRouteRef = useRef(handleSelectRoute);
  useEffect(() => {
    handleSelectRouteRef.current = handleSelectRoute;
  });
  const onVehicleClick = useCallback((routeId: string, routeType: number, tripId: string) => {
    handleSelectRouteRef.current(routeId, routeType, undefined, tripId, undefined, undefined, true);
  }, []);
  const onVehicleSelect = useCallback(
    (tripId: string) => focusVehicle(tripId, { follow: true }),
    [focusVehicle]
  );

  const selectedRoute = selectedRouteId ? routesById.get(selectedRouteId) : null;
  const selectedStop = selectedStopId ? stopsById.get(selectedStopId) : null;
  const selectedStopAlerts = selectedStop
    ? (alertsByStopId.get(selectedStop.id) ?? EMPTY_ALERTS)
    : EMPTY_ALERTS;
  const selectedRouteAlerts = selectedRouteId
    ? (alertsByRouteId.get(selectedRouteId) ?? EMPTY_ALERTS)
    : EMPTY_ALERTS;

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <div className="min-h-svh flex items-center justify-center">
        <div className="text-center">
          <div className="loading loading-spinner loading-lg" />
          <div className="mt-4">{t(`gtfs.${config.loadingI18nKey}`)}</div>
        </div>
      </div>
    );
  }

  if (initialError) {
    return (
      <div className="min-h-svh flex items-center justify-center p-4">
        <div className="alert alert-error max-w-md">
          <span>{t('gtfs.initialError', { message: initialError.message })}</span>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <GTFSModeProvider config={config}>
      <div className="h-svh w-screen overflow-hidden relative">
        {/* Full-screen map */}
        <MapView
          alertStopIds={alertStopIds}
          allVehicles={selectedRouteId ? [] : allVehicles}
          autoZoomToRoute={
            !!selectedRouteId &&
            !vehicleFocus?.isFollowing &&
            !(vehicleFocus?.routeId === selectedRouteId && !!vehicleFocus.tripId)
          }
          congestionPoints={congestionPoints}
          followedVehiclePos={followedVehiclePos}
          highlightStopIds={activeHighlightStopIds}
          locationPanOffsetY={
            nearbyOpen &&
            nearbyStopsListExpanded &&
            typeof window !== 'undefined' &&
            window.innerWidth < 640
              ? -Math.round(window.innerHeight / 4)
              : 0
          }
          onFlyToStop={
            selectedStop
              ? () =>
                  setParentStationZoomTarget({
                    lat: selectedStop.lat,
                    lon: selectedStop.lon,
                    panOffsetY:
                      typeof window !== 'undefined' && window.innerWidth < 640
                        ? -Math.round(window.innerHeight / 4)
                        : 0,
                    zoom: config.stopZoom,
                  })
              : undefined
          }
          onFollowDisengage={handleStopFollowing}
          onStopClick={handleStopClickFromMap}
          onVehicleClick={onVehicleClick}
          onVehicleSelect={onVehicleSelect}
          onZoomComplete={handleZoomComplete}
          orderedStops={orderedStops}
          parentChildCounts={parentChildCounts}
          parentStations={parentStations}
          parentStationZoomTarget={parentStationZoomTarget}
          platformStops={platformStops}
          previewVehiclePos={
            vehicleFocus?.routeId === selectedRouteId &&
            !vehicleFocus.isFollowing &&
            vehicleFocus.tripId &&
            vehiclePositions.get(vehicleFocus.tripId)
              ? {
                  lat: vehiclePositions.get(vehicleFocus.tripId)!.latitude,
                  lon: vehiclePositions.get(vehicleFocus.tripId)!.longitude,
                }
              : null
          }
          previewVehicleTripId={
            vehicleFocus?.routeId === selectedRouteId && !vehicleFocus.isFollowing
              ? vehicleFocus.tripId
              : null
          }
          roadClosures={isTransit ? roadClosures : undefined}
          routesById={routesById}
          routeShapes={shapes}
          routeShortName={selectedRoute?.shortName}
          routeStops={routeStops}
          routeType={selectedRouteType}
          selectedRouteId={selectedRouteId}
          selectedStop={selectedStop && !stopModalOpen ? selectedStop : null}
          selectedStopId={selectedStopId}
          serviceId={serviceId}
          showCongestionHeatmap={config.hasRealtime && showCongestionHeatmap}
          userLocation={userLocation}
          vehicleFollowOffsetY={
            !!vehicleFocus?.isFollowing && typeof window !== 'undefined' && window.innerWidth < 640
              ? -Math.round(window.innerHeight / 4)
              : 0
          }
          vehicles={vehicles}
          zoomTrigger={zoomToRouteTrigger}
        />

        {/* Route loading indicator — only when the small route bar isn't already visible */}
        {routeLoading &&
          (!selectedRoute || routeViewLargeOpen || stopModalOpen || !!selectedStopId) && (
            <div className="absolute top-[calc(4rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[1000]">
              <div className="alert alert-info py-2 px-4 shadow-lg">
                <span className="loading loading-spinner loading-sm" />
                <span>{t('gtfs.loadingRoute')}</span>
              </div>
            </div>
          )}

        {/* Disruptions (service alerts + road closures) + realtime technical details (debug only); z above Leaflet bottom chrome */}
        {isTransit && (
          <div className="absolute bottom-[max(1.5rem,calc(env(safe-area-inset-bottom,0px)+1rem))] right-[max(1rem,env(safe-area-inset-right))] z-[1100] flex items-center justify-end gap-2">
            <DisruptionsPanel
              alerts={serviceAlerts}
              closures={roadClosures}
              onRefresh={refetchClosures}
              onRouteClick={(routeId, routeType) => handleSelectRoute(routeId, routeType)}
              onStopHighlight={handleAlertStopHighlight}
              pastAlerts={pastAlerts}
              refreshCooldownSecondsLeft={closuresRefreshSecondsLeft}
              refreshedAtMs={closuresRefreshedAtMs}
              refreshing={closuresLoading}
              refreshLocked={closuresRefreshLocked}
              routesById={routesById}
              selectedRouteId={selectedRouteId}
            />
            {config.hasRealtime && realtimeStats && sandboxVisible && (
              <RealtimeStatusPanel
                cacheAgeSeconds={cacheAgeSeconds}
                cacheStatus={cacheStatus}
                fetchLatencyMs={fetchLatencyMs}
                lastUpdate={lastUpdate}
                nextPollAtMs={nextPollAtMs}
                realtimeLoading={realtimeLoading}
                realtimeStats={realtimeStats}
                ref={realtimePanelRef}
                workerTimestamp={workerTimestamp}
              />
            )}
          </div>
        )}

        {/* Low-zoom hint when vehicles and stops are hidden (transit only) */}
        {config.hasRealtime && mapZoom <= MAP_ZOOM_TRANSIT_STOPS_HINT_THRESHOLD && (
          <div className="absolute top-[calc(5rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[1000]">
            <div className="badge badge-neutral gap-2 shadow text-xs sm:text-sm opacity-90 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full bg-amber-50 animate-ping" />
              {t('gtfs.zoomForStopsAndVehicles')}
            </div>
          </div>
        )}

        {/* No-realtime notice (train mode) */}
        {!config.hasRealtime && (
          <div className="absolute bottom-6 right-4 z-[1000]">
            <div className="badge badge-neutral gap-1.5 shadow text-[11px] opacity-80">
              <Train className="w-3 h-3" />
              {t('gtfs.trainNoLiveTracking')}
            </div>
          </div>
        )}

        {/* Congestion summary badge */}
        {/* GUŽVE functionality hidden for now
        {config.hasRealtime && showCongestionHeatmap && congestionSummary && (
          <div className="absolute bottom-6 left-4 z-[1000]">
            <div className="bg-base-100/90 backdrop-blur-sm rounded-xl shadow-lg border border-base-200 px-3 py-2 text-xs space-y-1 max-w-52">
              <div className="font-bold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                Zagušenja tramvaja
              </div>
              <div className="text-base-content/70">
                Prosj. kašnjenje: <span className="font-semibold text-base-content">{Math.round(congestionSummary.averageDelay / 60)} min</span>
              </div>
              <div className="text-base-content/70">
                {congestionSummary.stopsWithData} stanica s podacima
              </div>
              {(congestionSummary.severeCount > 0 || congestionSummary.highCount > 0) && (
                <div className="text-error font-semibold">
                  {congestionSummary.severeCount + congestionSummary.highCount} kritičnih stanica
                </div>
              )}
            </div>
          </div>
        )}
        */}

        {/* Route Info Bar */}
        {selectedRoute &&
          !routeViewLargeOpen &&
          !stopModalOpen &&
          !selectedStopId &&
          (() => {
            const isFollowing =
              (vehicleFocus?.routeId === selectedRouteId && vehicleFocus?.isFollowing) ?? false;
            const activeTripId =
              vehicleFocus?.routeId === selectedRouteId ? (vehicleFocus?.tripId ?? null) : null;
            const activeVehicle = activeTripId
              ? (vehicles.find((v) => v.tripId === activeTripId) ?? null)
              : null;
            const activeVehiclePos = isFollowing
              ? followedVehicleParsedPos
              : activeTripId
                ? (vehiclePositions.get(activeTripId) ?? null)
                : null;
            const activeTripUpdate = isFollowing
              ? followedTripUpdate
              : activeTripId
                ? (tripUpdates.get(activeTripId) ?? null)
                : null;
            const journeyDirectionKey = journeyContext
              ? directionFilter === 'B'
                ? '1'
                : '0'
              : null;

            return (
              <RouteVehiclePanel
                activeTripId={activeTripId}
                clickedTripUpdate={activeTripUpdate}
                clickedVehicle={activeVehicle}
                clickedVehiclePos={activeVehiclePos}
                isFollowing={isFollowing}
                journeyDirectionKey={journeyDirectionKey}
                journeyFromParentId={journeyContext?.fromParentId ?? null}
                journeyToParentId={journeyContext?.toParentId ?? null}
                loading={routeLoading}
                onBackToJourney={journeyContext ? handleBackToJourney : undefined}
                onClose={handleClearRoute}
                onExpand={handleExpandRoute}
                onFollowStart={handleFollowStart}
                onStopClick={handleStopClickFromRoute}
                onStopFollowing={handleStopFollowing}
                onVehicleClick={handleVehicleClickFromRoute}
                orderedStops={orderedStops}
                route={selectedRoute}
                routeAlerts={selectedRouteAlerts}
                routesById={routesById}
                routeTimetable={routeTimetable}
                stopsById={stopsById}
                timetableLoading={timetableLoading}
                vehicles={vehicles}
              />
            );
          })()}

        {/* Stop Info Bar */}
        {selectedStop && !stopModalOpen && (
          <StopInfoBar
            journeyFilter={
              stopJourneyFilter && stopJourneyFilter.stopId === selectedStopId
                ? stopJourneyFilter
                : null
            }
            onClearJourneyFilter={() => setStopJourneyFilter(null)}
            onClose={handleCloseStopInfo}
            onExpand={handleExpandStop}
            onRouteClick={handleRouteClickFromStop}
            onStopSelect={handleSelectStop}
            routesById={routesById}
            stackBelow={false}
            stop={selectedStop}
            stopAlerts={selectedStopAlerts}
            stopsById={stopsById}
          />
        )}

        {/* Floating search: circular icon (same footprint as locate) until route is shown in-bar */}
        <div className="absolute top-[max(0.5rem,env(safe-area-inset-top))] left-[max(0.5rem,env(safe-area-inset-left))] right-32 sm:left-[max(1rem,env(safe-area-inset-left))] sm:right-auto sm:top-[max(1rem,env(safe-area-inset-top))] z-[1000]">
          {selectedRoute && routeViewLargeOpen ? (
            <div className="w-full sm:w-80 flex items-center gap-2 bg-base-100 rounded-xl px-4 py-3 shadow-lg">
              <button
                className="flex-1 flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
                onClick={() => {
                  trackEvent('search_opened');
                  setSearchModalOpen(true);
                }}
                type="button"
              >
                <Search className="w-5 h-5 text-base-content/50 shrink-0" />
                <span className="text-sm flex-1">
                  <span
                    className="badge font-bold mr-2 text-white"
                    style={{ backgroundColor: routeBadgeColor(selectedRoute) }}
                  >
                    {selectedRoute.shortName}
                    {isNightRoute(selectedRoute) && <NightMoon />}
                  </span>
                  <span className="text-base-content/70">{selectedRoute.longName}</span>
                </span>
              </button>
              <button
                aria-label={t('search.clearSelectionAria')}
                className="btn btn-ghost btn-circle btn-xs min-h-[32px] min-w-[32px]"
                onClick={handleClearRoute}
                type="button"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              aria-label={
                config.id === 'train'
                  ? t('search.barPlaceholderTrains')
                  : t('search.barPlaceholderLines')
              }
              className="btn btn-circle btn-gps-inactive p-0 min-h-0 w-10 h-10 min-h-10 sm:w-14 sm:h-14 sm:min-h-14 shadow-2xl transition-all duration-300 ring-2 ring-white/5"
              onClick={() => {
                trackEvent('search_opened');
                setSearchModalOpen(true);
              }}
              type="button"
            >
              <Search className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          )}
        </div>

        {/* Floating plan journey button */}
        <div className="absolute top-[max(0.5rem,env(safe-area-inset-top))] left-[calc(3.5rem+env(safe-area-inset-left))] sm:top-[max(1rem,env(safe-area-inset-top))] sm:left-[calc(5rem+env(safe-area-inset-left))] z-[1000]">
          <button
            aria-label={t('search.planJourney')}
            className="btn btn-circle btn-gps-inactive p-0 min-h-0 w-10 h-10 min-h-10 sm:w-14 sm:h-14 sm:min-h-14 shadow-2xl transition-all duration-300 ring-2 ring-white/5"
            onClick={() => {
              trackEvent('directions_opened');
              openPlanJourney();
            }}
            type="button"
          >
            <RouteIcon className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>
        </div>

        {/* Locate error toast */}
        {locateError && (
          <div className="absolute top-[calc(4rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[1300]">
            <div className="alert alert-error py-2 px-4 shadow-lg text-xs max-w-72 text-center">
              <span>{locateError}</span>
            </div>
          </div>
        )}

        {/* Debug panel (transit only, requires sandbox mode enabled in Settings) */}
        {config.hasRealtime && sandboxVisible && (
          <DebugPanel
            routesById={routesById}
            selectedStopId={selectedStopId}
            selectedTripId={vehicleFocus?.tripId ?? null}
            stopsById={stopsById}
          />
        )}

        {/* Directions Modal */}
        <DirectionsModal
          initialFromStop={
            directionsRestore ? (stopsById.get(directionsRestore.fromParentId) ?? null) : null
          }
          initialToStop={
            directionsRestore ? (stopsById.get(directionsRestore.toParentId) ?? null) : null
          }
          isOpen={directionsModalOpen}
          onClose={() => setDirectionsModalOpen(false)}
          onSelectJourneyStop={handleSelectJourneyStop}
          onSelectRoute={handleSelectRoute}
          routes={routes}
          stops={stops}
          stopsById={stopsById}
          vehicles={allVehicles}
        />

        {/* Search Modal */}
        <SearchModal
          isOpen={searchModalOpen}
          onClose={() => setSearchModalOpen(false)}
          onSelectRoute={handleSelectRoute}
          onSelectStop={handleSelectStop}
          routes={routes}
          stops={stops}
          stopsById={stopsById}
        />

        {/* Route Modal */}
        {selectedRoute && (
          <RouteViewLarge
            focusedTripId={
              vehicleFocus?.routeId === selectedRouteId ? (vehicleFocus?.tripId ?? null) : null
            }
            initialDirectionFilter={directionFilter}
            isOpen={routeViewLargeOpen}
            journeyFromParentId={journeyContext?.fromParentId ?? null}
            journeyToParentId={journeyContext?.toParentId ?? null}
            onClose={handleCloseRoute}
            onStopClick={handleStopClickFromRoute}
            onVehicleClick={handleVehicleClickFromRoute}
            orderedStops={orderedStops}
            route={selectedRoute}
            routeStops={routeStops}
            routeTimetable={routeTimetable}
            serviceId={serviceId}
            stopsById={stopsById}
            vehicles={vehicles}
          />
        )}

        {/* Stop Modal */}
        {selectedStop && (
          <StopModal
            isOpen={stopModalOpen}
            journeyFilter={
              stopJourneyFilter && stopJourneyFilter.stopId === selectedStopId
                ? stopJourneyFilter
                : null
            }
            onClearJourneyFilter={() => setStopJourneyFilter(null)}
            onClose={handleCloseStop}
            onRouteClick={handleRouteClickFromStop}
            onStopSelect={handleSelectStop}
            routesById={routesById}
            stop={selectedStop}
            stopAlerts={selectedStopAlerts}
            stopsById={stopsById}
          />
        )}

        {/* Nearby Stops Modal */}
        {userLocation && (
          <NearbyStopsModal
            isOpen={nearbyOpen}
            listExpanded={nearbyStopsListExpanded}
            onClose={() => setNearbyPanelOpen(false)}
            onListExpandedChange={setNearbyStopsListExpanded}
            onSelectStop={handleSelectStopFromNearby}
            stops={platformStops}
            userLat={userLocation.lat}
            userLon={userLocation.lon}
          />
        )}

        {/* Onboarding Wizard */}
        <OnboardingWizard variant={config.onboardingVariant} />
      </div>
    </GTFSModeProvider>
  );
}
