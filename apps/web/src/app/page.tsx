import type { Metadata } from 'next';
import bundle from '../data/recorded-run.json' with { type: 'json' };
import { ProductHome } from '../components/product-home';
import type { RecordedRun } from '../demo/types';

export const metadata: Metadata = {
  title: 'Phoenix — New code. Same banking behaviour.',
  description: 'A recorded comparison of a Java banking service and its replacement across 10 scenarios.',
};

export default function HomePage() {
  return <ProductHome run={bundle as RecordedRun} />;
}
