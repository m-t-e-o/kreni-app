/**
 * Render stop markers on the map
 */

import L from 'leaflet';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Marker, Polyline, useMap } from 'react-leaflet';

import { useSettingsStore } from '../../stores/settingsStore';
import { fetchStopTimetable, type Route, type Stop } from '../../utils/gtfs';
import { isNightRoute } from '../../utils/nightLines';
import {
  buildDirectionalStopPinPathData,
  buildParentLabelGroups,
  estimateSpiderRouteBadgeRowWidth,
  SPIDER_TICKER_VISIBLE_PX,
  TERMINUS_INNER_RADIUS_RATIO,
  TERMINUS_RADIUS_SCALE,
} from '../../utils/stopMarkersMath';
import { getDirectionColor } from './directionColors';
import {
  MARKER_Z_STOP_DEFAULT,
  MARKER_Z_STOP_HIGHLIGHTED,
  MARKER_Z_STOP_PARENT_LABEL,
  MARKER_Z_STOP_SELECTED,
} from './mapMarkerZIndex';
import { useSpiderfierContext } from './SpiderfierContext';

/**
 * Filled crescent, matching lucide's `moon` outline. Inlined because spider
 * labels are built as HTML strings for a Leaflet DivIcon and never pass through
 * React — see RouteBadge for the component the rest of the app uses.
 */
const NIGHT_MOON_SVG =
  `<svg class="spider-route-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

interface PlatformStopMarkerProps {
  color: string;
  effectiveFactor: number;
  /** When true, overlays a small warning badge (stop has an active service alert). */
  hasAlert: boolean;
  isDark: boolean;
  isHighlighted: boolean;
  isSelected: boolean;
  onStopClick: (id: string) => void;
  routesById: Map<string, Route>;
  stop: Stop;
}

interface StopMarkersProps {
  /** Stop ids (platform + parent) with an active ZET service alert — badged on the map. */
  alertStopIds: Set<string>;
  highlightStopIds: string[];
  isParentStationView: boolean;
  onStopClick: (stopId: string) => void;
  /** 0 or 1: hide non-selected stops at low zoom (transit); selected stops always stay at 1. */
  opacityFactor?: number;
  parentChildCounts: Map<string, number>; // platform-counts per parent station id
  /** Optional parent station list (used when individual mode wants parent labels/lines) */
  parentStations?: Stop[];
  routesById: Map<string, Route>;
  selectedStopId: null | string;
  /** When true, platform stop labels are rendered inside the DivIcon (used at max zoom) */
  showLabels?: boolean;
  /** Optional mapping stopId -> direction index (0,1,...) for highlighted stops */
  stopDirectionMap?: Record<string, number>;
  stops: Stop[];
}

// ── Platform stop sub-component (registers with spiderfier) ────────────────

export function StopMarkers({
  alertStopIds,
  highlightStopIds,
  isParentStationView,
  onStopClick,
  opacityFactor = 1,
  parentChildCounts,
  parentStations,
  routesById,
  selectedStopId,
  showLabels = false,
  stopDirectionMap,
  stops,
}: StopMarkersProps) {
  const isDark = useSettingsStore((s) => s.theme) === 'dark';
  const highlightSet = new Set(highlightStopIds as string[]);

  // Build a lookup of parent stations by id for quick access
  const parentMap = new Map<string, Stop>();
  if (parentStations) parentStations.forEach((p) => parentMap.set(p.id, p));

  const parentLabelGroups =
    showLabels && parentStations
      ? buildParentLabelGroups(
          stops.filter((s) => s.locationType === 0),
          parentMap
        )
      : [];
  return (
    <>
      {stops.map((s) => {
        const stop = s as Stop;
        const id = stop.id;

        const isSelected = id === selectedStopId;
        const isHighlighted = highlightSet.has(id);
        const hasAlert = alertStopIds.has(id);

        // Render parent stations when in parent-station view
        if (isParentStationView && stop.locationType === 1) {
          const childCount = parentChildCounts.get(stop.id) || 0;
          const displayCount = childCount > 9 ? '9+' : childCount.toString();

          const icon = L.divIcon({
            className: 'parent-station-icon',
            html: `<div data-testid="stop-marker" class="parent-station-marker ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''}" style="position:relative;">
              <span class="count">${displayCount}</span>
              ${hasAlert ? STOP_ALERT_BADGE_CORNER : ''}
            </div>`,
            iconAnchor: [14, 14],
            iconSize: [28, 28],
          });

          return (
            <Marker
              eventHandlers={{
                click: () => onStopClick(stop.id),
              }}
              icon={icon}
              key={stop.id}
              position={[stop.lat, stop.lon]}
              zIndexOffset={
                isSelected
                  ? MARKER_Z_STOP_SELECTED
                  : isHighlighted
                    ? MARKER_Z_STOP_HIGHLIGHTED
                    : MARKER_Z_STOP_DEFAULT
              }
            />
          );
        }

        // Render regular platform stops
        // Selected stops always remain fully visible regardless of opacityFactor
        const effectiveFactor = isSelected ? 1 : opacityFactor;
        // Skip rendering when fully transparent (perf optimisation)
        if (effectiveFactor === 0) return null;

        // If highlighted and a direction map is available, use the direction color
        let color = stopFillColor(stop, isSelected, isHighlighted, isDark);
        if (isHighlighted && stopDirectionMap && stopDirectionMap[id] !== undefined) {
          const dirIdx = stopDirectionMap[id];
          color = getDirectionColor(stop.routeType ?? null, dirIdx, isDark);
        }
        return (
          <PlatformStopMarker
            color={color}
            effectiveFactor={effectiveFactor}
            hasAlert={hasAlert}
            isDark={isDark}
            isHighlighted={isHighlighted}
            isSelected={isSelected}
            key={stop.id}
            onStopClick={onStopClick}
            routesById={routesById}
            stop={stop}
          />
        );
      })}
      {/* Render parent labels and connector lines when requested (individual-mode enhancement) */}
      {showLabels &&
        parentLabelGroups.map(({ children, label, lat, lon }, idx) => (
          <span key={`parent-label-${idx}`}>
            <Marker
              icon={L.divIcon({
                className: '',
                html: `<span class="parent-station-label">${String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`,
                iconAnchor: [0, 0],
                iconSize: [0, 0],
              })}
              interactive={false}
              position={[lat, lon]}
              zIndexOffset={MARKER_Z_STOP_PARENT_LABEL}
            />
            {children.map((c) => (
              <Polyline
                key={`line-${idx}-${c.id}`}
                pathOptions={{ color: '#9ca3af', dashArray: '3 4', opacity: 0.45, weight: 0.8 }}
                positions={[
                  [lat, lon],
                  [c.lat, c.lon],
                ]}
              />
            ))}
          </span>
        ))}
    </>
  );
}

/** Amber "!" disc placed at the top-right corner of a marker with an active alert. */
const STOP_ALERT_BADGE_COLOR = '#f59e0b'; // Tailwind amber-500 (warning)

/** Corner badge for the fixed-size parent-station marker (CSS-positioned). */
const STOP_ALERT_BADGE_CORNER =
  `<span style="position:absolute;top:-3px;right:-3px;width:12px;height:12px;border-radius:50%;` +
  `background:${STOP_ALERT_BADGE_COLOR};border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.4);` +
  `display:flex;align-items:center;justify-content:center;">` +
  `<span style="color:#fff;font-weight:800;font-size:9px;line-height:1;font-family:system-ui,sans-serif;">!</span></span>`;

/** Alert badge overlay for an SVG stop marker, positioned near the coloured disc. */
function alertBadgeHtml(cx: number, radius: number, stroke: string): string {
  const bs = Math.max(11, radius * 1.5);
  const centerX = cx + radius * 0.85;
  const centerY = cx - radius * 0.85;
  return (
    `<span style="position:absolute;left:${(centerX - bs / 2).toFixed(1)}px;top:${(centerY - bs / 2).toFixed(1)}px;` +
    `width:${bs.toFixed(1)}px;height:${bs.toFixed(1)}px;border-radius:50%;background:${STOP_ALERT_BADGE_COLOR};` +
    `border:1.5px solid ${stroke};box-shadow:0 1px 2px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">` +
    `<span style="color:#fff;font-weight:800;font-size:${(bs * 0.72).toFixed(1)}px;line-height:1;font-family:system-ui,sans-serif;">!</span></span>`
  );
}

/**
 * Build a DivIcon for a platform stop marker.
 * When `bearing` is supplied a small directional triangle is rendered
 * just outside the circle, pointing in the direction of travel.
 * `terminus` stops draw a ring instead — nothing continues past them, so a
 * direction of travel would be misleading.
 */
function makeStopIcon(
  color: string,
  bearing: number | undefined,
  size: number,
  r: number,
  opacityFactor: number,
  isDark: boolean,
  label?: string,
  terminus?: boolean,
  hasAlert?: boolean
): L.DivIcon {
  const cx = size / 2;
  const safeLabel = label
    ? String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : '';
  // A pale outline keeps stops distinct from both streets and building fills.
  const stroke = isDark ? '#cbd5e1' : 'white';

  if (terminus) {
    // Ring: the outer disc in the stop colour with a punched-out centre, the
    // conventional end-of-line mark on transit maps. Drawn larger than a through
    // stop so it reads as a landmark, not just a differently shaped dot.
    const ringR = r * TERMINUS_RADIUS_SCALE;
    const html =
      `<div data-testid="stop-marker" class="stop-marker-pin" style="position:relative;width:${size}px;height:${size}px;">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"` +
      ` style="opacity:${opacityFactor};filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35));overflow:visible;">` +
      `<circle cx="${cx}" cy="${cx}" r="${ringR.toFixed(2)}" fill="${color}" fill-opacity="0.95" stroke="${stroke}" stroke-width="2.5"/>` +
      `<circle cx="${cx}" cy="${cx}" r="${(ringR * TERMINUS_INNER_RADIUS_RATIO).toFixed(2)}" fill="${stroke}"/>` +
      `</svg>` +
      `${safeLabel ? `<span class="stop-label">${safeLabel}</span>` : ''}` +
      `${hasAlert ? alertBadgeHtml(cx, ringR, stroke) : ''}` +
      `</div>`;
    return L.divIcon({ className: '', html, iconAnchor: [cx, cx], iconSize: [size, size] });
  }

  if (bearing !== undefined) {
    const pathData = buildDirectionalStopPinPathData(cx);

    const html =
      `<div data-testid="stop-marker" class="stop-marker-pin" style="position:relative;width:${size}px;height:${size}px;opacity:${opacityFactor};">` +
      `<svg style="position:absolute;top:0;left:0;transform:rotate(${bearing}deg);transform-origin:${cx}px ${cx}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));overflow:visible;"` +
      ` width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      // The Unified Silhouette
      `<path d="${pathData}" fill="${color}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `</svg>` +
      `${safeLabel ? `<span class="stop-label">${safeLabel}</span>` : ''}` +
      `${hasAlert ? alertBadgeHtml(cx, r, stroke) : ''}` +
      `</div>`;
    return L.divIcon({ className: '', html, iconAnchor: [cx, cx], iconSize: [size, size] });
  }

  const html =
    `<div data-testid="stop-marker" class="stop-marker-pin" style="position:relative;width:${size}px;height:${size}px;">` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"` +
    ` style="opacity:${opacityFactor};filter:drop-shadow(0 2px 3px rgba(0,0,0,0.35));overflow:visible;">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="${color}" fill-opacity="0.95" stroke="${stroke}" stroke-width="2.5"/>` +
    `</svg>` +
    `${safeLabel ? `<span class="stop-label">${safeLabel}</span>` : ''}` +
    `${hasAlert ? alertBadgeHtml(cx, r, stroke) : ''}` +
    `</div>`;
  return L.divIcon({ className: '', html, iconAnchor: [cx, cx], iconSize: [size, size] });
}

const PlatformStopMarker = memo(function PlatformStopMarker({
  color,
  effectiveFactor,
  hasAlert,
  isDark,
  isHighlighted,
  isSelected,
  onStopClick,
  routesById,
  stop,
}: PlatformStopMarkerProps) {
  const map = useMap();
  const ctx = useSpiderfierContext();

  // Compute icon before hooks/effects so iconRef always holds the latest value
  // Standard is 32/6, so selected is doubled to 64/12.
  const size = isSelected ? 64 : isHighlighted ? 38 : 32;
  const r = isSelected ? 12 : isHighlighted ? 7.5 : 6;
  // Rail stations render as plain dots — the directional bearing pin looks off
  // for the sparse, non-platform HŽ network, so drop the bearing for rail.
  const bearing = stop.routeType === 2 ? undefined : stop.bearing;
  const terminus = stop.terminus === true;
  const icon = useMemo(
    () =>
      makeStopIcon(color, bearing, size, r, effectiveFactor, isDark, undefined, terminus, hasAlert),
    [color, bearing, size, r, effectiveFactor, isDark, terminus, hasAlert]
  );
  const iconRef = useRef(icon);
  useLayoutEffect(() => {
    iconRef.current = icon;
  }, [icon]);

  useEffect(() => {
    if (!ctx) return;

    // Resolve a more descriptive label on-demand (e.g. including route info)
    const resolveLabel = async () => {
      try {
        const timetable = await fetchStopTimetable(stop.id);
        const routes = Object.keys(timetable)
          .map((rid) => routesById.get(rid))
          .filter((r): r is Route => !!r)
          .sort((a, b) => {
            const numA = parseInt(a.shortName, 10);
            const numB = parseInt(b.shortName, 10);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return a.shortName.localeCompare(b.shortName);
          });

        if (routes.length === 0) return stop.name;

        const renderedBadges = routes
          .map((r) => {
            // Night lines take their own class instead of the route-type one —
            // the night colour replaces the tram blue rather than tinting it.
            const typeClass = isNightRoute(r)
              ? 'is-night'
              : r.type === 0
                ? 'is-tram'
                : r.type === 3
                  ? 'is-bus'
                  : 'is-mixed';
            // These badges are an HTML string inside a Leaflet DivIcon, so the
            // moon is an inline SVG rather than the lucide React component the
            // rest of the app uses (RouteBadge). Same glyph, drawn by hand.
            const moon = isNightRoute(r) ? NIGHT_MOON_SVG : '';
            return `<span class="spider-route-badge ${typeClass}">${r.shortName}${moon}</span>`;
          })
          .join('');

        const estimatedWidth = estimateSpiderRouteBadgeRowWidth(routes.map((r) => r.shortName));

        const badgeContent =
          estimatedWidth <= SPIDER_TICKER_VISIBLE_PX
            ? // Fits — plain static row, no animation, no mask, no duplication
              `<div class="spider-route-badges">${renderedBadges}</div>`
            : // Overflows — scrolling ticker with seamless doubled content
              `<div class="spider-route-ticker"><div class="spider-route-ticker-inner">${renderedBadges}${renderedBadges}</div></div>`;

        return `<div class="spider-label-content"><span class="stop-name">${stop.name}</span>${badgeContent}</div>`;
      } catch (err) {
        console.error('Failed to resolve routes for stop', stop.id, err);
        return stop.name;
      }
    };

    ctx.register({
      getIcon: () => iconRef.current,
      id: stop.id,
      label: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      onClick: () => onStopClick(stop.id),
      resolveLabel,
    });
    return () => ctx.unregister(stop.id);
  }, [stop.id, stop.lat, stop.lon, stop.name, onStopClick, ctx, routesById]);

  // Hide when the SpiderfierManager is rendering this marker in the fan
  if (ctx?.isHidden(stop.id)) return null;

  return (
    <Marker
      eventHandlers={{
        click: (e) => {
          e.originalEvent.stopPropagation();
          if (ctx) {
            ctx.triggerSpiderfy(stop.id, map);
          } else {
            onStopClick(stop.id);
          }
        },
      }}
      icon={icon}
      position={[stop.lat, stop.lon]}
      zIndexOffset={isSelected ? 10000 : isHighlighted ? 500 : 0}
    />
  );
});

// ── Stop colour by service type ──────────────────────────────────────────────
function stopFillColor(
  stop: Stop,
  isSelected: boolean,
  isHighlighted: boolean,
  isDark: boolean
): string {
  if (isHighlighted && !isSelected) return '#2337ff';
  switch (stop.routeType) {
    case 0:
      return isDark ? '#60a5fa' : '#2563eb'; // tram-only  → blue
    case 2:
      return isDark ? '#f87171' : '#dc2626'; // rail       → red
    case 3:
      return isDark ? '#fbbf24' : '#d97706'; // bus-only   → amber
    default:
      return isDark ? '#94a3b8' : '#475569'; // fallback    → slate
  }
}
