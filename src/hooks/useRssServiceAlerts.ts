import { useEffect, useMemo, useState } from 'react';

import type { Route, Stop } from '../utils/gtfs';
import type { ParsedServiceAlert } from '../utils/realtime';
import type { StopNameIndex } from '../utils/stopNameMatch';

import { GTFS_API_KEY, GTFS_PROXY_URL } from '../config';
import { isExpiredServiceAlert } from '../utils/serviceAlertExpiry';
import { buildStopNameIndex, matchStopName } from '../utils/stopNameMatch';

// Fields the parser derives from the LLM are optional on the wire: a partial
// model response omits keys, and JSON.stringify drops the resulting undefined
// values on the way into KV. Only the feed-derived fields are guaranteed.
interface RssAlert {
  affectedStops?: string[];
  confirmedEndDate?: null | string;
  endDate: null | string;
  guid: string;
  id: string;
  lines?: string[];
  processedAt: string;
  pubDate: string;
  startDate: null | string;
  summary?: string;
  title: string;
  type?: RssAlertType;
  url: string;
}

interface RssAlertsFile {
  alerts: RssAlert[];
  lastUpdate: string;
}

type RssAlertType =
  'cancellation' | 'new-service' | 'other' | 'replacement' | 'route-change' | 'stop-change';

const TYPE_TO_EFFECT: Record<RssAlertType, string> = {
  cancellation: 'NO_SERVICE',
  'new-service': 'ADDITIONAL_SERVICE',
  other: 'OTHER_EFFECT',
  // Rail-replacement and the like: the line still runs, just not as a tram. It
  // used to share `cancellation`, which rendered "Nema usluge" over an alert
  // that in fact told the rider a bus was coming.
  replacement: 'MODIFIED_SERVICE',
  'route-change': 'DETOUR',
  'stop-change': 'STOP_MOVED',
};

const CACHE_KEY = 'kreni-rss-alerts-cache';
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes – alerts update every 4 h

/** Exported for testing — the pure mapping from wire shape to render shape. */
export function convertToServiceAlerts(
  rssAlerts: RssAlert[],
  routesById: Map<string, Route>,
  stopIndex: StopNameIndex
): ParsedServiceAlert[] {
  // Build a short-name → routeId index once
  const shortNameIndex = new Map<string, string>();
  for (const [id, route] of routesById) {
    shortNameIndex.set(route.shortName, id);
  }

  // Preserve all feed items here. The hook partitions only source-verified
  // end dates into history; raw LLM endDate remains informational because
  // guessed dates used to silently bury valid alerts.
  //
  // Every LLM-derived field is defaulted rather than assumed: a partial model
  // response reaches us with keys missing, and reading through one of them threw
  // for the whole batch — one bad record used to hide all of them.
  return rssAlerts.map((a): ParsedServiceAlert => {
    // Keep each alert's stop names attached to the platforms they resolved to,
    // so the card can offer one button per stop instead of a single catch-all.
    // Names that match nothing are dropped — a button that pans nowhere is noise.
    const stops = (a.affectedStops ?? [])
      .map((name) => ({ ids: matchStopName(name, stopIndex), name }))
      .filter((s) => s.ids.length > 0);

    return {
      activeSince: toActivePosix(a.startDate),
      activeUntil: toActivePosix(a.endDate),
      cause: 'OTHER_CAUSE',
      confirmedEndDate: a.confirmedEndDate,
      // Falls back to the title so a summary-less alert still reads as something.
      description: a.summary ?? a.title,
      effect: (a.type && TYPE_TO_EFFECT[a.type]) ?? 'OTHER_EFFECT',
      header: a.title,
      id: `rss-${a.id}`,
      routeIds: (a.lines ?? [])
        .map((line) => shortNameIndex.get(line))
        .filter((id): id is string => id !== undefined),
      stopIds: [...new Set(stops.flatMap((s) => s.ids))],
      stops,
      url: a.url,
    };
  });
}

export function useRssServiceAlerts(
  routesById: Map<string, Route>,
  stops: Stop[]
): { alerts: ParsedServiceAlert[]; pastAlerts: ParsedServiceAlert[] } {
  const [alerts, setAlerts] = useState<ParsedServiceAlert[]>([]);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNowMs(Date.now());
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // Stop-name → id index for matching alerts' `affectedStops`. Stable after the
  // initial data load; rebuilt only when the stop list itself changes.
  const stopIndex = useMemo(() => buildStopNameIndex(stops), [stops]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Try localStorage cache
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, ts }: { data: RssAlert[]; ts: number } = JSON.parse(cached);
          if (Date.now() - ts < CACHE_DURATION_MS) {
            if (!cancelled) {
              setAlerts(convertToServiceAlerts(data, routesById, stopIndex));
            }
            return;
          }
        }
      } catch {
        // ignore corrupt cache
      }

      try {
        if (!GTFS_PROXY_URL) return;

        const headers: Record<string, string> = {};
        if (GTFS_API_KEY) headers['X-API-Key'] = GTFS_API_KEY;
        const res = await fetch(`${GTFS_PROXY_URL}?endpoint=service-alerts`, { headers });
        if (!res.ok) return;
        const json: RssAlertsFile = await res.json();

        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ data: json.alerts, ts: Date.now() }));
        } catch {
          // storage quota exceeded – ignore
        }

        if (!cancelled) {
          setAlerts(convertToServiceAlerts(json.alerts, routesById, stopIndex));
        }
      } catch (err) {
        // RSS alerts are non-critical, so a failure stays non-fatal — but it is
        // no longer invisible: swallowing this silently made an empty panel
        // indistinguishable from "no disruptions".
        console.warn('[rss-alerts] failed to load service alerts', err);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // routesById is a new Map reference on every render but its content is stable
    // after initial data load. Using .size as a proxy dep avoids infinite re-runs
    // while still re-fetching once routes are available. stopIndex is memoized on
    // the stop list, so it too is stable after load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesById.size, stopIndex]);

  return useMemo(
    () => ({
      alerts: alerts.filter((a) => !isExpiredServiceAlert(a, nowMs)),
      pastAlerts: alerts.filter((a) => isExpiredServiceAlert(a, nowMs)),
    }),
    [alerts, nowMs]
  );
}

function toActivePosix(dateStr: null | string): null | number {
  if (!dateStr) return null;
  const ts = Date.parse(dateStr);
  return isNaN(ts) ? null : Math.floor(ts / 1000);
}
