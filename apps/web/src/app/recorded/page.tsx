import type { Metadata } from 'next';
import bundle from '../../data/recorded-run.json' with { type: 'json' };
import { RunIndex } from '../../components/run-index';
import { RecordedDashboard } from '../../demo/dashboard';
import type { RecordedRun } from '../../demo/types';
import { resolveWorkspace } from '../../data/repo-root';
import { assertFeaturedIntact, featuredRun, scanRuns } from '../../data/runs';

export const metadata: Metadata = {
  title: 'Evidence — Phoenix',
  description: 'The recorded comparison, the rules that were checked, and the files behind them.',
};

export default function RecordedRunPage() {
  const ws = resolveWorkspace();
  const runs = scanRuns(ws);
  const featured = featuredRun(runs);
  assertFeaturedIntact(featured);
  return (
    <>
      <RecordedDashboard run={bundle as RecordedRun} />
      <RunIndex ws={ws} runs={runs} featured={featured} />
    </>
  );
}
