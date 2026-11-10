/**
 * Scrollable list body for transit service alerts.
 * Extracted from the former ServiceAlerts modal so it can live inside the
 * shared Disruptions tabbed panel.
 */

import { ArrowRight, Ban, Bus, Calendar, ChevronRight, Info, MapPin, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Route } from '../../../utils/gtfs';
import type { ParsedServiceAlert } from '../../../utils/realtime';

import { isNightRoute } from '../../../utils/nightLines';
import { routeBadgeColor } from '../../../utils/routeStyle';
import { serviceAlertEffectLabel } from '../../../utils/serviceAlertEffectLabel';
import { NightMoon } from '../NightMoon';

// ── Per-effect visual config ───────────────────────────────────────────────
type EffectStyle = {
  badge: string; // DaisyUI badge variant
  border: string; // left border colour class
  icon: React.ReactNode;
};

interface ServiceAlertsListProps {
  alerts: ParsedServiceAlert[];
  /** Closes the enclosing modal (used when a route badge or stops chip is tapped). */
  onClose: () => void;
  onRouteClick?: (routeId: string, routeType: number) => void;
  /** Pan/pulse the map to the alert's affected stops. */
  onStopHighlight?: (stopIds: string[]) => void;
  pastAlerts?: ParsedServiceAlert[];
  routesById: Map<string, Route>;
  selectedRouteId?: null | string;
}

export function ServiceAlertsList({
  alerts,
  onClose,
  onRouteClick,
  onStopHighlight,
  pastAlerts = [],
  routesById,
  selectedRouteId,
}: ServiceAlertsListProps) {
  const { t } = useTranslation();

  // Relevant alerts first when a route is selected
  const sorted = [...alerts].sort((a, b) => {
    const relevant = (alert: ParsedServiceAlert) =>
      selectedRouteId && alert.routeIds.includes(selectedRouteId) ? 1 : 0;
    return relevant(b) - relevant(a) || Number(!!a.dateNeedsReview) - Number(!!b.dateNeedsReview);
  });

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-base-300">
      {sorted.map((alert) => {
        const isRelevant = !!(selectedRouteId && alert.routeIds.includes(selectedRouteId));
        const style = effectStyle(alert.effect);

        return (
          <div
            // Relevance is marked with a neutral tint, never with colour: the
            // colour belongs to the effect and has to mean the same thing
            // whatever happens to be selected.
            className={`p-4 border-l-4 ${style.border} ${isRelevant ? 'bg-base-200/60' : 'hover:bg-base-200/50'} transition-colors`}
            key={alert.id}
          >
            {/* Top row: icon + effect badge + ZET link */}
            <div className="flex items-center gap-2 mb-2">
              {style.icon}
              <span className={`badge badge-sm ${style.badge}`}>
                {serviceAlertEffectLabel(alert.effect, t)}
              </span>
              {alert.url && (
                <a
                  className="ml-auto text-xs text-base-content/40 hover:text-primary underline underline-offset-2 transition-colors"
                  href={alert.url}
                  onClick={(e) => e.stopPropagation()}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  zet.hr ↗
                </a>
              )}
            </div>

            {/* Title */}
            {alert.header && (
              <p className="font-semibold text-sm mb-1 leading-snug">{alert.header}</p>
            )}

            {/* Description */}
            {alert.description && (
              <p className="text-xs text-base-content/65 mb-1 leading-relaxed">
                {alert.description}
              </p>
            )}

            {/* Date range */}
            <DateRange since={alert.activeSince} until={alert.activeUntil} />
            {alert.dateNeedsReview && (
              <p className="mt-1 text-xs text-base-content/60">{t('disruptions.dateReview')}</p>
            )}

            {/* Affected routes + stops, collapsed by default. Every badge here
                carries a saturated colour, so a card with several routes read as
                a wall of colour — the disclosure keeps the list scannable. */}
            {(alert.routeIds.length > 0 || (alert.stopIds.length > 0 && onStopHighlight)) && (
              <details className="group mt-3">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-base-content/55 transition-colors hover:text-base-content/80 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90" />
                  {t('disruptions.affectedRoutesAndStops')}
                </summary>

                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {alert.routeIds.map((rid) => {
                    const route = routesById.get(rid);
                    if (!route) return null;
                    return (
                      <button
                        className="badge badge-sm font-bold gap-1 hover:opacity-80 transition-opacity cursor-pointer text-white"
                        key={rid}
                        onClick={() => {
                          onRouteClick?.(rid, route.type);
                          onClose();
                        }}
                        style={{ backgroundColor: routeBadgeColor(route) }}
                      >
                        {route.shortName}
                        {isNightRoute(route) && <NightMoon />}
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    );
                  })}

                  {/* One button per named stop. GTFS-RT alerts inform on raw stop
                      ids with no names, so those keep the single catch-all. */}
                  {onStopHighlight &&
                    (alert.stops?.length
                      ? alert.stops.map((stop) => (
                          <button
                            aria-label={t('disruptions.showStopOnMapAria', { name: stop.name })}
                            className="badge badge-sm badge-outline gap-1 hover:bg-base-200 transition-colors cursor-pointer"
                            key={stop.name}
                            onClick={() => {
                              onStopHighlight(stop.ids);
                              onClose();
                            }}
                            type="button"
                          >
                            <MapPin className="w-3 h-3 shrink-0" />
                            {stop.name}
                          </button>
                        ))
                      : alert.stopIds.length > 0 && (
                          <button
                            className="badge badge-sm badge-outline gap-1 hover:bg-base-200 transition-colors cursor-pointer"
                            onClick={() => {
                              onStopHighlight(alert.stopIds);
                              onClose();
                            }}
                            type="button"
                          >
                            <MapPin className="w-3 h-3" />
                            {t('disruptions.showStopsOnMap')}
                          </button>
                        ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
      {pastAlerts.length > 0 && (
        <details className="p-4">
          <summary className="cursor-pointer text-sm text-base-content/60">
            {t('disruptions.pastNotices')} ({pastAlerts.length})
          </summary>
          <div className="mt-3 opacity-70">
            <ServiceAlertsList
              alerts={pastAlerts}
              onClose={onClose}
              onRouteClick={onRouteClick}
              onStopHighlight={onStopHighlight}
              routesById={routesById}
              selectedRouteId={selectedRouteId}
            />
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Colour and icon for an alert, from its effect alone.
 *
 * Deliberately takes nothing else: this used to escalate every alert on the
 * selected route to red with a generic warning icon, which made the same alert
 * render differently depending on what was selected and — worse — put a red
 * badge next to a label reading "Stanica premještena" or "Dodatna usluga".
 * Relevance is conveyed by the sort order and a neutral row tint instead.
 */
function effectStyle(effect: string): EffectStyle {
  switch (effect) {
    case 'ADDITIONAL_SERVICE':
      return {
        badge: 'badge-success',
        border: 'border-l-success',
        icon: <Plus className="w-4 h-4 text-success" />,
      };
    case 'DETOUR':
    case 'MODIFIED_SERVICE':
    case 'REDUCED_SERVICE':
    case 'SIGNIFICANT_DELAYS':
      return {
        badge: 'badge-warning',
        border: 'border-l-warning',
        icon: <Bus className="w-4 h-4 text-warning" />,
      };
    case 'NO_SERVICE':
      return {
        badge: 'badge-error',
        border: 'border-l-error',
        icon: <Ban className="w-4 h-4 text-error" />,
      };
    case 'STOP_MOVED':
      return {
        badge: 'badge-info',
        border: 'border-l-info',
        icon: <MapPin className="w-4 h-4 text-info" />,
      };
    default:
      return {
        badge: 'badge-ghost',
        border: 'border-l-base-300',
        icon: <Info className="w-4 h-4 text-base-content/50" />,
      };
  }
}

// ── Date helpers ───────────────────────────────────────────────────────────
const DATE_FMT = new Intl.DateTimeFormat('hr-HR', { day: 'numeric', month: 'short' });

interface DateRangeProps {
  since: null | number;
  until: null | number;
}

function DateRange({ since, until }: DateRangeProps) {
  const { t } = useTranslation();
  if (!since && !until) return null;
  return (
    <div className="flex items-center gap-1 text-xs text-base-content/60 mt-2">
      <Calendar className="w-3 h-3 shrink-0" />
      {since && until ? (
        <>
          <span>{fmtDate(since)}</span>
          <ArrowRight className="w-3 h-3" />
          <span>{fmtDate(until)}</span>
        </>
      ) : since ? (
        <span>{t('serviceAlerts.dateFrom', { date: fmtDate(since) })}</span>
      ) : (
        <span>{t('serviceAlerts.dateUntil', { date: fmtDate(until!) })}</span>
      )}
    </div>
  );
}

function fmtDate(posixSec: number): string {
  return DATE_FMT.format(new Date(posixSec * 1000));
}
