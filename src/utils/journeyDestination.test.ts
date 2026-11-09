import { describe, expect, it } from 'vitest';

import type { Stop } from './gtfs';

import { exceptionalJourneyEnd } from './journeyDestination';

const stops = new Map(
  ['start', 'middle', 'end', 'depot', 'other-platform'].map((id) => [
    id,
    {
      id,
      name: id,
      parentStation: id === 'other-platform' ? 'terminal' : id === 'end' ? 'terminal' : null,
    } as Stop,
  ])
);
const normal = { '0': ['start', 'middle', 'end'], '1': ['end', 'middle', 'start'] };
const trip = (...ids: string[]): [string, number, number][] =>
  ids.map((id, i) => [id, i, 1440 + i]);
describe('exceptional journey destination', () => {
  it('labels a depot journey with its headsign, without changing the main route', () => {
    expect(exceptionalJourneyEnd(trip('middle', 'depot'), normal, stops, 'Spr. Trešnj.')).toBe(
      'Spr. Trešnj.'
    );
    expect(normal['0']).toEqual(['start', 'middle', 'end']);
  });
  it('does not flag normal or first journeys ending at the normal terminus', () => {
    expect(exceptionalJourneyEnd(trip('start', 'middle', 'end'), normal, stops)).toBeNull();
    expect(exceptionalJourneyEnd(trip('middle', 'end'), normal, stops)).toBeNull();
    expect(exceptionalJourneyEnd(trip('middle', 'other-platform'), normal, stops)).toBeNull();
  });
  it('handles short overnight trips and missing metadata conservatively', () => {
    expect(exceptionalJourneyEnd(trip('start', 'middle'), normal, stops)).toBe('middle');
    expect(exceptionalJourneyEnd(undefined, normal, stops)).toBeNull();
    expect(exceptionalJourneyEnd(trip('missing'), normal, stops)).toBeNull();
  });
});
