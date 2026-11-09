import type { Stop } from './gtfs';

/** Only the selected journey gets an exception label; canonical route lists stay untouched. */
export function exceptionalJourneyEnd(
  tripStops: readonly [string, number, number][] | undefined,
  orderedStops: Record<string, string[]> | undefined,
  stopsById: Map<string, Stop> | undefined,
  headsign?: string
): null | string {
  if (!tripStops?.length || !orderedStops || !stopsById) return null;
  const endId = tripStops[tripStops.length - 1][0];
  const end = stopsById.get(endId);
  if (!end) return null;
  const canonicalEnds = Object.values(orderedStops)
    .filter((ids) => ids.length > 0)
    .map((ids) => ids[ids.length - 1]);
  if (canonicalEnds.length === 0) return null;
  if (
    canonicalEnds.some((id) => {
      const normal = stopsById.get(id);
      return (
        id === endId ||
        (!!end.parentStation && end.parentStation === normal?.parentStation) ||
        end.name.trim().toLocaleLowerCase() === normal?.name.trim().toLocaleLowerCase()
      );
    })
  )
    return null;
  return headsign?.trim() || end.name;
}
