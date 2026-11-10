import { useEffect, useMemo, useState } from 'react';

import type { RouteTimetable, Stop } from '../utils/gtfs';

import { fetchRouteTimetable } from '../utils/gtfs';
import { nextTransitJourney } from '../utils/transitJourneyTime';
import { useInitialData } from './useInitialData';

export function useTransitJourneyTimes(
  routeIds: string[],
  from: null | string,
  to: null | string,
  stopsById: Map<string, Stop>,
  dataDir: string
) {
  const [tables, setTables] = useState(new Map<string, RouteTimetable>());
  const [loading, setLoading] = useState(false);
  const [completedKey, setCompletedKey] = useState('');
  const [nowMs, setNowMs] = useState(Date.now);
  const { calendar, loading: calendarLoading } = useInitialData({ dataDir });
  const routeKey = [...new Set(routeIds)].sort().join(',');
  const requestKey = JSON.stringify([dataDir, routeKey, from, to]);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setTables(new Map());
    if (!routeKey || !from || !to) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      routeKey.split(',').map(async (id) => {
        try {
          return [id, await fetchRouteTimetable(id, dataDir)] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setTables(new Map(entries.filter((entry) => entry !== null)));
      setCompletedKey(requestKey);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [routeKey, dataDir, from, to, requestKey]);
  const times = useMemo(
    () =>
      new Map(
        [...tables].map(([id, table]) => [
          id,
          from && to ? nextTransitJourney(table, from, to, stopsById, calendar, nowMs) : null,
        ])
      ),
    [tables, from, to, stopsById, calendar, nowMs]
  );
  return {
    loading:
      !!routeKey && !!from && !!to && (loading || calendarLoading || completedKey !== requestKey),
    times,
  };
}
