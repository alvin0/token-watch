import { useStore } from "./store";
import { Header } from "./components/Header";
import { PeriodTabs } from "./components/PeriodTabs";
import { SourceTabs } from "./components/SourceTabs";
import { SummaryCard } from "./components/SummaryCard";
import { InsightCards } from "./components/InsightCards";
import { CompositionCard } from "./components/CompositionCard";
import { TrendChart } from "./components/TrendChart";
import { TopModelsCard } from "./components/TopModelsCard";
import { RecentPeriodsCard } from "./components/RecentPeriodsCard";
import { TodayInsightsCard } from "./components/TodayInsightsCard";
import { FooterBar } from "./components/FooterBar";
import { LoadingState } from "./components/LoadingState";
import { EmptyState } from "./components/EmptyState";
import type { Period } from "./lib/periodData";

export function App() {
  const progress = useStore((s) => s.progress);
  const results = useStore((s) => s.results);
  const granularity = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  const setFilter = useStore((s) => s.setFilter);
  const freshness = useStore((s) => s.freshness);
  const hasData = Object.keys(results).length > 0;
  const isLoading = progress !== undefined && progress.partial;

  if (isLoading && !hasData) {
    return <LoadingState processed={progress.processed} total={progress.total} />;
  }
  if (!hasData) { return <EmptyState />; }

  const status = isLoading ? "Scanning" : freshness.latestRecordUtc ? "Live" : "Paused";
  const activeSource = sources && sources.length === 1 ? sources[0] : "all";

  return (
    <div className="tw-flex tw-flex-col tw-h-full tw-overflow-hidden">
      <Header status={status} />
      <SourceTabs selected={activeSource} onChange={(s) => {
        setFilter({ sources: s === "all" ? undefined : [s as "codex" | "claude"] });
      }} />
      <PeriodTabs selected={granularity}
        onChange={(p) => setFilter({ granularity: p })} />
      <div className="tw-flex-1 tw-overflow-y-auto tw-px-3 tw-pb-3 tw-space-y-2.5">
        <SummaryCard />
        <InsightCards />
        <CompositionCard />
        {granularity === "today" ? <TodayInsightsCard /> : <TrendChart />}
        <TopModelsCard />
        {granularity !== "today" && <RecentPeriodsCard />}
      </div>
      <FooterBar />
    </div>
  );
}
