/**
 * Tabbed modal combining transit service alerts and road closures.
 * Presentational: open state + active tab are owned by DisruptionsPanel.
 */

import { AlertTriangle, Construction, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RoadClosure } from '../../../hooks/useRoadClosures';
import type { Route } from '../../../utils/gtfs';
import type { ParsedServiceAlert } from '../../../utils/realtime';

import { FullScreenModalCard } from './FullScreenModalCard';
import { RoadClosuresList, RoadClosuresRefreshFooter } from './RoadClosuresList';
import { ServiceAlertsList } from './ServiceAlertsList';

export type DisruptionTab = 'alerts' | 'closures';

interface DisruptionsModalProps {
  activeTab: DisruptionTab;
  alerts: ParsedServiceAlert[];
  closures: RoadClosure[];
  onClose: () => void;
  onRefresh: () => void;
  onRouteClick?: (routeId: string, routeType: number) => void;
  onStopHighlight?: (stopIds: string[]) => void;
  onTabChange: (tab: DisruptionTab) => void;
  pastAlerts?: ParsedServiceAlert[];
  refreshCooldownSecondsLeft: null | number;
  refreshedAtMs: null | number;
  refreshing: boolean;
  refreshLocked: boolean;
  routesById: Map<string, Route>;
  selectedRouteId?: null | string;
}

interface TabButtonProps {
  active: boolean;
  count: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

export function DisruptionsModal({
  activeTab,
  alerts,
  closures,
  onClose,
  onRefresh,
  onRouteClick,
  onStopHighlight,
  onTabChange,
  pastAlerts = [],
  refreshCooldownSecondsLeft,
  refreshedAtMs,
  refreshing,
  refreshLocked,
  routesById,
  selectedRouteId,
}: DisruptionsModalProps) {
  const { t } = useTranslation();

  return (
    <FullScreenModalCard onClose={onClose}>
      {/* Header: tab bar + close */}
      <div className="p-2 pl-3 border-b border-base-300 flex items-center gap-2">
        <div className="tabs tabs-boxed bg-base-200/60 flex-1" role="tablist">
          <TabButton
            active={activeTab === 'alerts'}
            count={alerts.length}
            icon={<AlertTriangle className="w-4 h-4" />}
            label={t('disruptions.tabAlerts')}
            onClick={() => onTabChange('alerts')}
          />
          <TabButton
            active={activeTab === 'closures'}
            count={closures.length}
            icon={<Construction className="w-4 h-4" />}
            label={t('disruptions.tabClosures')}
            onClick={() => onTabChange('closures')}
          />
        </div>
        <button
          aria-label={t('disruptions.closeAria')}
          className="btn btn-ghost btn-circle btn-sm min-h-[44px] min-w-[44px]"
          onClick={onClose}
          type="button"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Body */}
      {activeTab === 'alerts' ? (
        <ServiceAlertsList
          alerts={alerts}
          onClose={onClose}
          onRouteClick={onRouteClick}
          onStopHighlight={onStopHighlight}
          pastAlerts={pastAlerts}
          routesById={routesById}
          selectedRouteId={selectedRouteId}
        />
      ) : (
        <>
          <RoadClosuresList closures={closures} />
          <RoadClosuresRefreshFooter
            onRefresh={onRefresh}
            refreshCooldownSecondsLeft={refreshCooldownSecondsLeft}
            refreshedAtMs={refreshedAtMs}
            refreshing={refreshing}
            refreshLocked={refreshLocked}
          />
        </>
      )}
    </FullScreenModalCard>
  );
}

function TabButton({ active, count, icon, label, onClick }: TabButtonProps) {
  // min-w-0 + flex-nowrap lets the label be the only thing that gives: without
  // them a long label ("Zatvorene ceste") pushed the count badge onto its own row.
  return (
    <button
      aria-selected={active}
      className={`tab flex min-w-0 flex-1 flex-nowrap gap-1.5 ${active ? 'tab-active font-semibold' : ''}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      <span className="badge badge-sm badge-ghost shrink-0">{count}</span>
    </button>
  );
}
