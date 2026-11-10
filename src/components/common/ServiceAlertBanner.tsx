/**
 * Warning banner listing ZET service alerts. Renders nothing when the list is
 * empty, so callers can pass their alerts through unguarded.
 *
 * The alerts themselves decide what a caller is: StopInfoBar and StopModal pass
 * the ones matched to a stop, RouteVehiclePanel the ones matched to the selected
 * route — whether or not a vehicle on it is focused. Nothing here is stop- or
 * route-specific.
 *
 * Two densities:
 *  - default — every alert open, with the route badges. Right for a stop, where
 *    "which lines does this hit" is the question being asked.
 *  - `compact` — title and until-date only, description behind a disclosure, no
 *    badges. Right for a route panel, where the badges would mostly repeat the
 *    line you are already looking at and three open alerts eat the screen.
 */

import { AlertTriangle, Calendar, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Route } from '../../utils/gtfs';
import type { ParsedServiceAlert } from '../../utils/realtime';

import { isNightRoute } from '../../utils/nightLines';
import { routeBadgeColor } from '../../utils/routeStyle';
import { serviceAlertEffectLabel } from '../../utils/serviceAlertEffectLabel';
import { NightMoon } from './NightMoon';

const DATE_FMT = new Intl.DateTimeFormat('hr-HR', { day: 'numeric', month: 'short' });

const SHELL = 'p-2 rounded-lg bg-warning/10 border border-warning/30';

interface CompactAlertRowProps {
  alert: ParsedServiceAlert;
  isOpen: boolean;
  onToggle: () => void;
  showIcon: boolean;
}

interface ServiceAlertBannerProps {
  alerts: ParsedServiceAlert[];
  className?: string;
  /** Collapse each alert to its title + date. See the module docblock. */
  compact?: boolean;
  routesById: Map<string, Route>;
}

export function ServiceAlertBanner({
  alerts,
  className,
  compact = false,
  routesById,
}: ServiceAlertBannerProps) {
  const { t } = useTranslation();
  if (alerts.length === 0) return null;

  if (compact) {
    return (
      <div className={`${SHELL} ${className ?? ''}`}>
        <CompactAlertList alerts={alerts} />
      </div>
    );
  }

  return (
    <div className={`${SHELL} space-y-2 ${className ?? ''}`}>
      {alerts.map((alert) => (
        <div className="flex gap-1.5 items-start" key={alert.id}>
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold leading-snug text-base-content/90">
              {alert.header || serviceAlertEffectLabel(alert.effect, t)}
            </p>
            {alert.description && alert.description !== alert.header && (
              <p className="text-[11px] text-base-content/70 leading-relaxed line-clamp-3">
                {alert.description}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {alert.routeIds.map((rid) => {
                const route = routesById.get(rid);
                if (!route) return null;
                return (
                  <span
                    className="badge badge-xs font-bold text-white border-0"
                    key={rid}
                    style={{ backgroundColor: routeBadgeColor(route) }}
                  >
                    {route.shortName}
                    {isNightRoute(route) && <NightMoon className="w-2.5 h-2.5" />}
                  </span>
                );
              })}
              {alert.activeUntil && (
                <span className="inline-flex items-center gap-0.5 text-[11px] text-base-content/60">
                  <Calendar className="w-3 h-3" />
                  {t('serviceAlerts.dateUntil', {
                    date: DATE_FMT.format(new Date(alert.activeUntil * 1000)),
                  })}
                </span>
              )}
              {alert.url && (
                <a
                  className="text-[11px] text-base-content/40 hover:text-primary underline underline-offset-2"
                  href={alert.url}
                  onClick={(e) => e.stopPropagation()}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  zet.hr ↗
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The compact list, as an accordion: at most one alert is expanded at a time.
 *
 * That cap is not styling — the panel this sits in (`RouteVehiclePanel`) is
 * `fixed` with no max-height and no scroll container of its own, so on a short
 * phone two or three open alerts push content off-screen with no way to reach
 * it. Collapsing the previous one keeps the panel bounded by construction.
 */
function CompactAlertList({ alerts }: { alerts: ParsedServiceAlert[] }) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<null | string>(null);

  return (
    <>
      {alerts.length > 1 && (
        <div className="flex items-center gap-1.5 mb-1">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
          <span className="text-xs font-semibold text-base-content/90">
            {t('serviceAlerts.count', { count: alerts.length })}
          </span>
        </div>
      )}
      <div className="divide-y divide-warning/20">
        {alerts.map((alert) => (
          <CompactAlertRow
            alert={alert}
            isOpen={openId === alert.id}
            key={alert.id}
            onToggle={() => setOpenId((current) => (current === alert.id ? null : alert.id))}
            showIcon={alerts.length === 1}
          />
        ))}
      </div>
    </>
  );
}

/**
 * One alert as a disclosure row: title and until-date always visible, the prose
 * only once asked for.
 *
 * Controlled rather than a native <details> because only one row may be open at
 * a time (see `CompactAlertList`) — which <details name> would give for free but
 * only on very recent browsers. The trade is that the ARIA has to be spelled out
 * by hand, below.
 *
 * The reveal animates via a `0fr → 1fr` grid row rather than max-height, so it
 * runs to the content's real height without a magic pixel cap that clips a long
 * alert. Suppressed under `prefers-reduced-motion`.
 */
function CompactAlertRow({ alert, isOpen, onToggle, showIcon }: CompactAlertRowProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const title = alert.header || serviceAlertEffectLabel(alert.effect, t);
  const hasDetail = (alert.description && alert.description !== alert.header) || alert.url;

  const heading = (
    <>
      {showIcon && <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />}
      <span className="flex-1 min-w-0 text-xs font-semibold leading-snug text-base-content/90">
        {title}
        {alert.dateNeedsReview && (
          <span className="block mt-1 font-normal text-base-content/60">
            {t('disruptions.dateReview')}
          </span>
        )}
      </span>
      {alert.activeUntil && (
        <span className="shrink-0 text-[11px] text-base-content/60">
          {t('serviceAlerts.dateUntil', {
            date: DATE_FMT.format(new Date(alert.activeUntil * 1000)),
          })}
        </span>
      )}
    </>
  );

  // Nothing to reveal — render the same row without the affordance, so a
  // summary-less alert doesn't offer a disclosure that opens onto blank space.
  if (!hasDetail) {
    return <div className="flex items-start gap-1.5 py-1.5">{heading}</div>;
  }

  return (
    <div>
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        className="flex w-full cursor-pointer items-start gap-1.5 py-1.5 text-left"
        onClick={onToggle}
        type="button"
      >
        {heading}
        <ChevronRight
          className={`w-3 h-3 shrink-0 mt-0.5 text-base-content/40 transition-transform duration-200 motion-reduce:transition-none ${
            isOpen ? 'rotate-90' : ''
          }`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
        id={panelId}
        role="region"
      >
        <div className="overflow-hidden">
          <div className="pb-1.5 space-y-1">
            {alert.description && alert.description !== alert.header && (
              <p className="text-[11px] text-base-content/70 leading-relaxed">
                {alert.description}
              </p>
            )}
            {alert.url && (
              <a
                className="inline-block text-[11px] text-base-content/40 hover:text-primary underline underline-offset-2"
                href={alert.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                zet.hr ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
