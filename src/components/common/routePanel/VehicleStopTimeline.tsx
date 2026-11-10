import { useTranslation } from 'react-i18next';

import type { VehicleStopPreview } from '../../../hooks/useVehicleStopPreview';

import { formatDistance } from '../../../utils/format';

interface VehicleStopTimelineProps {
  color: string;
  /** Whether a live GPS position exists (drives the no-stop-data fallback copy). */
  gpsActive: boolean;
  preview: VehicleStopPreview;
  timetableLoading?: boolean;
}

/**
 * Vertical metro-dot itinerary for the focused vehicle: the primary (next) stop
 * with its delay/distance pill, followed by the upcoming stops.
 */
export function VehicleStopTimeline({
  color,
  gpsActive,
  preview,
  timetableLoading = false,
}: VehicleStopTimelineProps) {
  const { t } = useTranslation();
  const { delayInfo, distanceMeters, primaryStopTime, stopDetail, stopLabel, upcomingStops } =
    preview;
  const state = preview.serviceState;
  const uncertain = state && state !== 'approaching';

  if (!stopDetail && uncertain)
    return (
      <p className="text-xs text-base-content/70" role="status">
        {t(
          state === 'pending' ? 'vehicleCard.departureUnconfirmed' : 'vehicleCard.arrivalUncertain'
        )}
      </p>
    );

  if (!stopDetail) {
    return (
      <div className="flex items-center gap-2 text-xs text-base-content/50">
        {gpsActive ? (
          <>
            <span className="w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
            <span>{t('routeBar.gpsActiveNoStop')}</span>
          </>
        ) : (
          <>
            <span className="loading loading-dots loading-xs" />
            <span>{t('routeBar.waitingGpsSignal')}</span>
          </>
        )}
      </div>
    );
  }

  const hasUpcoming = upcomingStops.length > 0 || timetableLoading;

  return (
    <div className="relative mt-1">
      {uncertain && (
        <p className="mb-3 text-xs text-base-content/70" role="status">
          {t(
            state === 'pending'
              ? 'vehicleCard.departureUnconfirmed'
              : state === 'stale'
                ? 'vehicleCard.feedStale'
                : 'vehicleCard.positionUnchanged'
          )}
        </p>
      )}
      {hasUpcoming && (
        <div className="absolute left-[7px] top-[10px] bottom-1 w-[2px] bg-base-content/20 rounded-full" />
      )}

      {/* Primary (next) stop */}
      <div className={`relative flex items-start ${hasUpcoming ? 'pb-3.5' : ''}`}>
        <div
          className="absolute left-0 top-[2px] w-4 h-4 rounded-full bg-base-100 border-[4.5px] z-10"
          style={{ borderColor: color }}
        />

        <div className="ml-8 min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <span className="font-semibold text-sm leading-snug text-base-content truncate">
              {stopDetail}
            </span>
            {primaryStopTime && (
              <span className="text-xs font-medium tabular-nums text-base-content/70 shrink-0">
                {primaryStopTime}
              </span>
            )}
          </div>
          {stopLabel && <div className="mt-0.5 text-xs text-base-content/50">{stopLabel}</div>}

          {(delayInfo || distanceMeters !== null) && (
            <div className="flex items-center gap-2 mt-2 px-2.5 py-1.5 w-fit rounded-md bg-base-200/70 border border-base-300/60 shadow-sm">
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${uncertain ? 'bg-base-content/40' : 'bg-success animate-pulse'}`}
              />
              <div className="flex flex-wrap items-center gap-x-2 text-xs">
                {delayInfo && (
                  <span
                    className={`font-medium ${delayInfo.positive ? 'text-success' : 'text-error'}`}
                  >
                    {delayInfo.text}
                  </span>
                )}
                {delayInfo && distanceMeters !== null && (
                  <span aria-hidden className="text-base-content/20">
                    |
                  </span>
                )}
                {distanceMeters !== null && (
                  <span className="font-medium text-base-content/60 tabular-nums">
                    {formatDistance(distanceMeters)}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Upcoming stops */}
      {upcomingStops.length > 0 ? (
        <div className="space-y-3.5">
          {upcomingStops.map((s, i) => (
            <div className="relative flex items-center text-xs text-base-content/70" key={i}>
              <div className="absolute left-[3px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-base-100 border-[2.5px] border-base-content/40 z-10" />
              <span className="ml-8 truncate font-medium">{s.name}</span>
              <span className="ml-auto shrink-0 tabular-nums text-base-content/50">{s.time}</span>
            </div>
          ))}
        </div>
      ) : timetableLoading ? (
        <div className="space-y-3.5">
          {[1, 2, 3].map((i) => (
            <div className="relative flex items-center text-xs" key={i}>
              <div className="absolute left-[3px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-base-100 border-[2.5px] border-base-content/20 z-10" />
              <div className="ml-8 skeleton h-3 w-32" />
              <div className="skeleton h-3 w-8 ml-auto" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
