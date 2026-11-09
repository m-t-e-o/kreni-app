import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { DisruptionsChip } from '../components/common/disruptions/DisruptionsChip';
import { ServiceAlertsList } from '../components/common/disruptions/ServiceAlertsList';
import { useRssServiceAlerts } from './useRssServiceAlerts';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

it('moves a confirmed notice into history while the app stays open', async () => {
  vi.useFakeTimers();
  const beforeMidnight = new Date('2026-11-08T22:59:50Z');
  vi.setSystemTime(beforeMidnight);
  const notice = {
    confirmedEndDate: '2026-11-08',
    endDate: '2026-11-08',
    guid: 'race',
    id: 'race',
    processedAt: '2026-11-06',
    pubDate: '2026-11-06',
    startDate: '2026-11-08',
    summary: 'Temporary diversion',
    title: 'Race notice',
    url: 'https://www.zet.hr/',
  };
  localStorage.setItem(
    'kreni-rss-alerts-cache',
    JSON.stringify({
      data: [
        notice,
        {
          ...notice,
          confirmedEndDate: null,
          id: 'uncertain',
          title: 'Ongoing notice',
        },
      ],
      ts: beforeMidnight.getTime(),
    })
  );
  let result: ReturnType<typeof useRssServiceAlerts>;
  const routes = new Map();
  const stops: [] = [];
  function Probe() {
    result = useRssServiceAlerts(routes, stops);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(<Probe />);
  });
  expect(result!.alerts).toHaveLength(2);
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(result!.alerts.map((a) => a.header)).toEqual(['Ongoing notice']);
  expect(result!.pastAlerts.map((a) => a.header)).toEqual(['Race notice']);

  const list = renderToStaticMarkup(
    <ServiceAlertsList
      alerts={result!.alerts}
      onClose={() => {}}
      pastAlerts={result!.pastAlerts}
      routesById={routes}
    />
  );
  expect(list).toContain('<details');
  expect(list).toContain('disruptions.pastNotices');
  expect(list).toContain('Race notice');
  const chip = renderToStaticMarkup(
    <DisruptionsChip alertsCount={0} closuresCount={0} hasPastAlerts onOpen={() => {}} />
  );
  expect(chip).toContain('disruptions.pastNotices');
  expect(chip).not.toContain('serviceAlerts.count');
});
