import type { MapContainerProps } from 'react-leaflet';

import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';

import { useNavigationStore } from '../../stores/navigationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { MAP_LEAFLET_MAX_ZOOM } from './mapZoomConstants';

const CYCLOSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://www.cyclosm.org/">CyclOSM</a>';

const CYCLOSM_TILE = {
  attribution: CYCLOSM_ATTRIBUTION,
  url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
} as const;

/** Exposes the Leaflet map instance on window.__leafletMap for E2E tests. */
function MapTestRef() {
  const map = useMap();
  useEffect(() => {
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true') {
      (window as unknown as Record<string, unknown>).__leafletMap = map;
    }
    return () => {
      if ((window as unknown as Record<string, unknown>).__leafletMap === map) {
        delete (window as unknown as Record<string, unknown>).__leafletMap;
      }
    };
  }, [map]);
  return null;
}

/**
 * CARTO began watermarking keyless raster tiles in August 2026: "API KEY
 * REQUIRED" stamped diagonally across the image, served as a normal 200. The
 * failure is therefore silent — nothing errors, the map is just defaced, and
 * the `CacheFirst` rule below happily stores it for 30 days.
 *
 * The key is free (5M tile requests/month against our measured ~100-250k) but
 * it is a *build-time* value: Cloudflare Pages and the Android build each need
 * `VITE_CARTO_KEY` in their environment or their tiles come back stamped.
 *
 * It is not a secret in any useful sense — a `VITE_` var is inlined into the
 * bundle and extractable from the APK. Keeping it out of the repo makes it
 * rotatable and unshared, not private.
 *
 * Left unset the URL simply carries no `key` param and the watermark shows.
 * That is deliberate: a contributor building this public repo sees exactly
 * what is missing, rather than a basemap silently swapped out from under them.
 *
 * CARTO is retiring the raster service in favour of vector, so treat this as a
 * bridge rather than a resting place.
 */
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY;

const cartoUrl = (style: string): string =>
  `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png` +
  (CARTO_KEY ? `?key=${CARTO_KEY}` : '');

const TILE_PROVIDERS = {
  'dark-matter': {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    url: cartoUrl('dark_all'),
  },
  osm: {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://www.hotosm.org/">HOT</a>',
    // Use the HOT (Humanitarian) tile style which has slightly more detail
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
  },
  positron: {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    url: cartoUrl('light_all'),
  },
};

interface BaseMapProps extends MapContainerProps {
  children?: React.ReactNode;
  /** When true, use CyclOSM full bike map tiles instead of theme-based CARTO/OSM basemap */
  cyclosmBasemap?: boolean;
  locationPanOffsetY?: number;
  userLocation?: null | { lat: number; lon: number };
}

export function BaseMap({
  children,
  cyclosmBasemap,
  locationPanOffsetY = 0,
  userLocation,
  ...mapProps
}: BaseMapProps) {
  const theme = useSettingsStore((state) => state.theme);
  const detailedMap = useSettingsStore((state) => state.detailedMap);
  const mapCenter = useSettingsStore((state) => state.mapCenter);
  const mapZoom = useSettingsStore((state) => state.mapZoom);

  const providerId: keyof typeof TILE_PROVIDERS = detailedMap
    ? 'osm'
    : theme === 'dark'
      ? 'dark-matter'
      : 'positron';
  const defaultTileConfig = TILE_PROVIDERS[providerId];
  const tileConfig = cyclosmBasemap ? CYCLOSM_TILE : defaultTileConfig;
  const tileLayerKey = cyclosmBasemap ? 'cyclosm' : providerId;

  return (
    <MapContainer
      center={mapCenter}
      className="w-full h-full"
      maxZoom={MAP_LEAFLET_MAX_ZOOM}
      minZoom={11}
      preferCanvas={true}
      style={{ height: '100%', width: '100%' }}
      zoom={mapZoom}
      zoomControl={false}
      {...mapProps}
    >
      {/*
        `crossOrigin` is a storage fix, not a rendering one.

        Without it Leaflet loads tiles as plain <img>, so the request is no-cors
        and the service worker caches an *opaque* response. Chromium pads opaque
        entries in quota accounting — it cannot let a page infer cross-origin
        response sizes — and the padding dwarfs the tile: measured on a real
        device, 1922 cached tiles of ~32 KB each were accounted at 13.44 GB, or
        ~7 MB apiece, against a 2 GB quota. That is the number users see under
        "Cookies and site data", and no `maxEntries` cap can fix it because the
        padding is per entry rather than per byte.

        Fetching in CORS mode makes the responses non-opaque and unpadded, so
        the same tiles account for what they actually weigh. All three providers
        (OSM HOT, CARTO, CyclOSM) send `access-control-allow-origin: *`. If one
        ever stops, its tiles fail to load rather than degrading quietly — the
        `cacheableResponse` rule in vite.config refuses to cache opaque
        responses at all now, so a regression shows up immediately instead of
        silently refilling the quota.
      */}
      <TileLayer
        attribution={tileConfig.attribution}
        className={
          providerId === 'dark-matter' && !cyclosmBasemap ? 'readable-dark-basemap' : undefined
        }
        crossOrigin="anonymous"
        keepBuffer={3}
        key={tileLayerKey}
        updateWhenIdle={true}
        url={tileConfig.url}
      />

      {userLocation && (
        <Marker
          icon={L.divIcon({
            className: 'user-location-icon',
            html: `<div data-testid="user-location-marker" class="user-location-marker"><span class="pulse"></span><span class="dot"></span></div>`,
            iconAnchor: [22, 22],
            iconSize: [44, 44],
          })}
          position={[userLocation.lat, userLocation.lon]}
        />
      )}

      <MapLocater panOffsetY={locationPanOffsetY} userLocation={userLocation} />
      <MapFlyToDispatcher />
      <MapPulseRing />
      <MapTestRef />
      <MapStateHandler />

      {children}
    </MapContainer>
  );
}

function MapLocater({
  panOffsetY = 0,
  userLocation,
}: {
  panOffsetY?: number;
  userLocation?: null | { lat: number; lon: number };
}) {
  const map = useMap();
  // Keep panOffsetY in a ref so changes to it don't re-trigger the fly.
  const panOffsetYRef = useRef(panOffsetY);
  // Sync the ref after every render (outside of render body to satisfy lint).
  useEffect(() => {
    panOffsetYRef.current = panOffsetY;
  });

  const locateTrigger = useNavigationStore((s) => s.locateTrigger);
  /** `triggerLocate()` runs in the same sync turn as `setUserLocation`; React may not
   *  have committed coords yet, so we wait until `userLocation` is non-null before flying. */
  const lastProcessedTriggerRef = useRef(0);
  const pendingLocateFlyRef = useRef(false);

  useEffect(() => {
    if (locateTrigger > lastProcessedTriggerRef.current) {
      lastProcessedTriggerRef.current = locateTrigger;
      pendingLocateFlyRef.current = true;
    }
  }, [locateTrigger]);

  useEffect(() => {
    if (!userLocation || !pendingLocateFlyRef.current) return;
    pendingLocateFlyRef.current = false;

    const zoom = 16;
    const offsetY = panOffsetYRef.current;
    if (offsetY !== 0) {
      // Pre-shift the fly target so the location marker lands in the
      // upper centre once the bottom sheet is visible — single animation.
      const point = map.project([userLocation.lat, userLocation.lon], zoom);
      const adjusted = map.unproject(L.point(point.x, point.y + offsetY), zoom);
      map.flyTo(adjusted, zoom, { duration: 1.5 });
    } else {
      map.flyTo([userLocation.lat, userLocation.lon], zoom, { duration: 1.5 });
    }
    // `locateTrigger` in deps so a later trigger (e.g. expand list on mobile) re-flies;
    // panOffsetY is read via ref at fly time.
  }, [userLocation, map, locateTrigger]);
  return null;
}

const MAP_FLY_TO_DEFAULT_ZOOM = 17;

function MapFlyToDispatcher() {
  const map = useMap();
  const mapFlyToRequestId = useNavigationStore((s) => s.mapFlyToRequestId);
  const lastHandledIdRef = useRef(0);

  useEffect(() => {
    if (mapFlyToRequestId === 0) return;
    if (mapFlyToRequestId === lastHandledIdRef.current) return;
    const pending = useNavigationStore.getState().mapFlyToPending;
    if (!pending) return;
    lastHandledIdRef.current = mapFlyToRequestId;
    useNavigationStore.setState({ mapFlyToPending: null });
    const z = Math.min(pending.zoom ?? MAP_FLY_TO_DEFAULT_ZOOM, map.getMaxZoom());
    map.flyTo([pending.lat, pending.lng], z, { duration: 1.15, easeLinearity: 0.25 });
  }, [map, mapFlyToRequestId]);

  return null;
}

function MapPulseRing() {
  const mapPulse = useNavigationStore((s) => s.mapPulse);
  const clearMapPulse = useNavigationStore((s) => s.clearMapPulse);

  useEffect(() => {
    if (!mapPulse) return;
    const ms = Math.max(0, mapPulse.until - Date.now());
    const timer = window.setTimeout(() => clearMapPulse(), ms);
    return () => window.clearTimeout(timer);
  }, [mapPulse, clearMapPulse]);

  if (!mapPulse) return null;

  const icon = L.divIcon({
    className: 'map-favourite-pulse-icon',
    html: '<div class="map-favourite-pulse-ring" aria-hidden="true"></div>',
    iconAnchor: [28, 28],
    iconSize: [56, 56],
  });

  return (
    <Marker
      icon={icon}
      interactive={false}
      position={[mapPulse.lat, mapPulse.lng]}
      zIndexOffset={700}
    />
  );
}

function MapStateHandler() {
  const setMapViewport = useSettingsStore((s) => s.setMapViewport);

  useMapEvents({
    moveend: (e) => {
      const map = e.target;
      const center = map.getCenter();
      setMapViewport([center.lat, center.lng], map.getZoom());
    },
    zoomend: (e) => {
      const map = e.target;
      const center = map.getCenter();
      setMapViewport([center.lat, center.lng], map.getZoom());
    },
  });

  return null;
}
