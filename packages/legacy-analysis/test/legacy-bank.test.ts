import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository, type RepositoryAnalysis } from '../src/index.js';

/**
 * Integration coverage against the real workload in `examples/legacy-bank`.
 *
 * These assertions are about *structure the analyzer must not miss* — routes, database-side
 * behaviour, the drifted fee calculation — not about the behaviours Phoenix is supposed to discover
 * by running the system. The ground truth for that lives in `benchmarks/`, outside the repository
 * Phoenix is given.
 */

const here = dirname(fileURLToPath(import.meta.url));
const legacyBank = join(here, '..', '..', '..', 'examples', 'legacy-bank');

let analysis: RepositoryAnalysis;

beforeAll(() => {
  if (!existsSync(join(legacyBank, 'pom.xml'))) throw new Error(`legacy bank not found at ${legacyBank}`);
  analysis = analyzeRepository({ root: legacyBank, generatedAt: '2026-09-30T00:00:00.000Z' });
});

describe('legacy-bank discovery', () => {
  it('inventories the whole repository', () => {
    expect(analysis.truncated).toBe(false);
    expect(analysis.repositoryMap.primaryLanguage).toBe('Java');
    expect(analysis.repositoryMap.fileCount).toBeGreaterThan(20);
    expect(analysis.repositoryMap.buildSystems[0]?.kind).toBe('maven');
    expect(analysis.repositoryMap.frameworks.map((framework) => framework.name)).toContain('spring-boot');
  });

  it('extracts every REST route with its real path', () => {
    const endpoints = analysis.repositoryMap.httpEndpoints;
    expect(endpoints.length).toBeGreaterThanOrEqual(16);
    expect(endpoints.every((endpoint) => endpoint.path.startsWith('/'))).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/transfers')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.path === '/api/accounts/{id}/history')).toBe(true);

    const routes = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    const collisions = endpoints
      .flatMap((endpoint) => endpoint.anomalies)
      .filter((anomaly) => anomaly.includes('route collides'));
    expect(collisions).toHaveLength(0);
  });

  it('finds behaviour that lives inside the database', () => {
    const objects = analysis.repositoryMap.databaseObjects.map((object) => `${object.kind}:${object.name}`);
    expect(objects).toContain('trigger:ledger_immutable');
    expect(objects).toContain('function:calc_transfer_fee');
    expect(objects).toContain('table:ledger_entries');

    const behaviorMigrations = analysis.repositoryMap.migrations.filter((migration) => migration.appliesDatabaseBehavior);
    expect(behaviorMigrations).toHaveLength(1);

    expect(
      analysis.repositoryMap.suspiciousBehaviors.filter((entry) => entry.category === 'db-side-behavior').length,
    ).toBeGreaterThanOrEqual(2);
    expect(analysis.repositoryMap.entryPoints.some((entry) => entry.kind === 'db-object')).toBe(true);
  });

  it('separates the online and batch fee paths, which do not agree', () => {
    const cluster = analysis.repositoryMap.duplicationClusters.find((entry) =>
      entry.members.some((member) => member.symbol === 'Utils#calcXferFeeOnline'),
    );
    expect(cluster?.drifted).toBe(true);
    expect(cluster?.members.map((member) => member.symbol)).toContain('Utils#calcXferFeeBatch');

    const online = analysis.dataFlow.flows.find((flow) => flow.name === 'POST /api/transfers');
    const batch = analysis.dataFlow.flows.find((flow) => flow.name === 'POST /api/settlement/run');
    expect(online?.steps.map((step) => step.component)).toContain('method:com.fnb.corebank.svc.Utils#calcXferFeeOnline');
    expect(batch?.steps.map((step) => step.component)).toContain('method:com.fnb.corebank.svc.Utils#calcXferFeeBatch');
    expect(batch?.dataStores).toContain('settlement_marker');
  });

  it('records the transaction and exception hazards with a usable location', () => {
    const behaviors = analysis.repositoryMap.suspiciousBehaviors;
    expect(behaviors.length).toBeGreaterThan(20);
    expect(behaviors.every((entry) => entry.location.startLine !== undefined)).toBe(true);
    expect(behaviors.every((entry) => entry.location.path.startsWith('src/'))).toBe(true);

    const independent = behaviors.filter((entry) => entry.description.includes('REQUIRES_NEW'));
    expect(independent.map((entry) => entry.location.symbol).sort()).toEqual(['collectFee', 'record']);

    expect(behaviors.some((entry) => entry.category === 'swallowed-exception')).toBe(true);
    expect(behaviors.some((entry) => entry.category === 'retry-without-idempotency')).toBe(true);
  });

  it('produces a graph whose edges all point at real nodes', () => {
    const ids = new Set(analysis.dependencyMap.nodes.map((node) => node.id));
    expect(analysis.dependencyMap.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
    expect(analysis.dependencyMap.hotspots.length).toBeGreaterThan(0);
    expect(analysis.dependencyMap.edges.some((edge) => edge.to === 'table:ledger_entries' && edge.kind === 'writes')).toBe(true);
  });

  it('cites evidence for every inferred flow', () => {
    expect(analysis.dataFlow.flows.length).toBeGreaterThanOrEqual(16);
    for (const flow of analysis.dataFlow.flows) {
      expect(flow.epistemicStatus).toBe('INFERRED');
      expect(flow.evidence.length).toBeGreaterThan(0);
      expect(flow.evidence[0]?.location?.path).toContain('ApiController.java');
    }
  });

  it('is reproducible', () => {
    const again = analyzeRepository({ root: legacyBank, generatedAt: '2026-09-30T00:00:00.000Z' });
    expect(JSON.stringify(again.repositoryMap)).toBe(JSON.stringify(analysis.repositoryMap));
    expect(JSON.stringify(again.dependencyMap)).toBe(JSON.stringify(analysis.dependencyMap));
    expect(JSON.stringify(again.dataFlow)).toBe(JSON.stringify(analysis.dataFlow));
  });
});
