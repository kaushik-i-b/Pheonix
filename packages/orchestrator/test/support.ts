import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { loadConfig, type PhoenixConfig } from '@phoenix/config';
import { analyzeRepository, type RepositoryAnalysis } from '@phoenix/legacy-analysis';
import { createLogger, newRunId, type Logger, type RunId } from '@phoenix/shared';
import type { CustomCheckContext } from '@phoenix/agent-runtime';

/**
 * A miniature legacy bank used by the orchestrator tests.
 *
 * It is deliberately small but structurally representative: a Maven manifest, Spring properties,
 * Flyway-style migrations including a database-side trigger, two fee calculators that disagree about
 * rounding, a swallowed exception, a scheduled job, and a pair of twin routes where only one checks
 * authorization. Every one of those is something the discovery stage must notice, and the fixture
 * lives here rather than in `examples/legacy-bank` so a test never depends on the demo system.
 */

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const FIXED_TIMESTAMP = '2026-09-30T00:00:00.000Z';

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>tiny-bank</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>1.8</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>2.1.4.RELEASE</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
  </dependencies>
</project>
`;

const PROPERTIES = `server.port=8080
spring.datasource.url=jdbc:postgresql://localhost:5432/tiny_bank
spring.datasource.username=tiny
spring.datasource.password=hunter2
tiny.fee.rate=0.005
tiny.fee.minimum=0.25
tiny.settlement.cron=0 5 0 * * *
`;

const V1_SCHEMA = `CREATE TABLE accounts (
    id BIGSERIAL PRIMARY KEY,
    account_number VARCHAR(34) NOT NULL UNIQUE,
    balance NUMERIC(19,2) NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts(id),
    amount NUMERIC(19,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
    id BIGSERIAL PRIMARY KEY,
    source_account VARCHAR(34) NOT NULL,
    target_account VARCHAR(34) NOT NULL,
    amount NUMERIC(19,2) NOT NULL,
    fee NUMERIC(19,2) NOT NULL,
    settled BOOLEAN NOT NULL DEFAULT FALSE
);
`;

const V2_TRIGGER = `CREATE OR REPLACE FUNCTION reject_negative_balance() RETURNS trigger AS $$
BEGIN
    IF NEW.balance < 0 THEN
        RAISE EXCEPTION 'account % would go negative', NEW.account_number;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_no_overdraft
    BEFORE UPDATE OF balance ON accounts
    FOR EACH ROW EXECUTE PROCEDURE reject_negative_balance();
`;

const FEE_SERVICE = `package com.example.fee;

import java.math.BigDecimal;
import java.math.RoundingMode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class FeeService {

    private static final BigDecimal RATE = new BigDecimal("0.005");
    private static final BigDecimal MINIMUM = new BigDecimal("0.25");

    private final JdbcTemplate jdbc;

    public FeeService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public BigDecimal onlineFee(BigDecimal amount) {
        BigDecimal fee = amount.multiply(RATE).setScale(2, RoundingMode.HALF_UP);
        if (fee.compareTo(MINIMUM) < 0) {
            fee = MINIMUM;
        }
        return fee;
    }

    public void record(String accountNumber, BigDecimal fee) {
        try {
            jdbc.update("INSERT INTO ledger_entries (account_id, amount) SELECT id, ? FROM accounts WHERE account_number = ?", fee, accountNumber);
        } catch (RuntimeException e) {
        }
    }
}
`;

const BATCH_FEE = `package com.example.fee;

import java.math.BigDecimal;
import java.math.RoundingMode;

public class BatchFeeCalculator {

    public BigDecimal batchFee(BigDecimal amount) {
        BigDecimal fee = amount.multiply(new BigDecimal("0.005")).setScale(2, RoundingMode.HALF_EVEN);
        if (fee.compareTo(new BigDecimal("0.25")) < 0) {
            fee = new BigDecimal("0.25");
        }
        return fee;
    }
}
`;

const CONTROLLER = `package com.example.web;

import com.example.fee.FeeService;
import java.math.BigDecimal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TransferController {

    private final FeeService fees;

    public TransferController(FeeService fees) {
        this.fees = fees;
    }

    @PostMapping("/api/transfers")
    public String transfer(@RequestParam("account") String account, @RequestParam("amount") String amount) {
        BigDecimal fee = fees.onlineFee(new BigDecimal(amount));
        fees.record(account, fee);
        return "OK";
    }

    @GetMapping("/api/internal/transfers/{account}/fee")
    public String internalFee(@PathVariable("account") String account) {
        return fees.onlineFee(BigDecimal.ONE).toPlainString() + account;
    }
}
`;

const SETTLEMENT_JOB = `package com.example.batch;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class SettlementJob {

    private final JdbcTemplate jdbc;

    public SettlementJob(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Scheduled(cron = "0 5 0 * * *")
    public void settle() {
        jdbc.update("UPDATE transfers SET settled = TRUE WHERE settled = FALSE");
    }
}
`;

const FILES: Record<string, string> = {
  'pom.xml': POM,
  'src/main/resources/application.properties': PROPERTIES,
  'src/main/resources/db/migration/V1__schema.sql': V1_SCHEMA,
  'src/main/resources/db/migration/V2__trigger.sql': V2_TRIGGER,
  'src/main/java/com/example/fee/FeeService.java': FEE_SERVICE,
  'src/main/java/com/example/fee/BatchFeeCalculator.java': BATCH_FEE,
  'src/main/java/com/example/web/TransferController.java': CONTROLLER,
  'src/main/java/com/example/batch/SettlementJob.java': SETTLEMENT_JOB,
};

export const FEE_SERVICE_PATH = 'src/main/java/com/example/fee/FeeService.java';
export const BATCH_FEE_PATH = 'src/main/java/com/example/fee/BatchFeeCalculator.java';
export const TRIGGER_PATH = 'src/main/resources/db/migration/V2__trigger.sql';
export const CONTROLLER_PATH = 'src/main/java/com/example/web/TransferController.java';

/** A quote that really appears in the fixture, with the line number the verifier will check. */
export function fixtureCitation(root: string, relativePath: string, needle: string): { path: string; startLine: number; quote: string } {
  const text = readFileSync(join(root, relativePath), 'utf8');
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture quote not found in ${relativePath}: ${needle}`);
  return { path: relativePath, startLine: index + 1, quote: lines[index]?.trim() ?? needle };
}

const directories: string[] = [];

export function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export function cleanupTemporaryDirectories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export interface LegacyFixture {
  root: string;
  artifactRoot: string;
  workspaceRoot: string;
  modernRoot: string;
  analysis: RepositoryAnalysis;
}

/** Writes the fixture repository, analyses it, and returns the temporary roots it lives in. */
export function createLegacyFixture(): LegacyFixture {
  const root = tempDirectory('phoenix-legacy-');
  for (const [relativePath, text] of Object.entries(FILES)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }
  return {
    root,
    artifactRoot: tempDirectory('phoenix-artifacts-'),
    workspaceRoot: tempDirectory('phoenix-workspace-'),
    modernRoot: tempDirectory('phoenix-modern-'),
    analysis: analyzeRepository({ root, generatedAt: FIXED_TIMESTAMP }),
  };
}

/** A configuration pointing at the fixture, with no ambient environment leaking in. */
export function fixtureConfig(
  fixture: Pick<LegacyFixture, 'root' | 'artifactRoot' | 'workspaceRoot' | 'modernRoot'>,
  overrides: Record<string, string> = {},
): PhoenixConfig {
  const { config } = loadConfig({
    cwd: REPO_ROOT,
    envFiles: [],
    env: {},
    overrides: {
      LLM_BASE_URL: 'http://localhost:9/v1',
      LLM_MODEL: 'fixture-model',
      LEGACY_ROOT: fixture.root,
      MODERN_ROOT: fixture.modernRoot,
      PHOENIX_ARTIFACT_ROOT: fixture.artifactRoot,
      PHOENIX_WORKSPACE_ROOT: fixture.workspaceRoot,
      ENABLE_EVENT_MIRROR: 'false',
      LOG_LEVEL: 'silent',
      MAX_AGENT_STEPS: '8',
      MAX_TOOL_CALLS_PER_AGENT: '12',
      STAGE_TIMEOUT_MS: '60000',
      ...overrides,
    },
  });
  return config;
}

export function silentLogger(): Logger {
  return createLogger({ component: 'orchestrator-test', level: 'silent' });
}

/**
 * The context a registered `CustomCheck` receives. A real store over an empty directory: checks
 * that only look at the analysis they were built with must not be given a shortcut through it.
 */
export function checkContext(artifactRoot: string, runId: RunId = newRunId()): CustomCheckContext {
  return {
    runId,
    artifacts: new FileArtifactStore(artifactRoot),
    generated: [],
    findings: [],
    testRuns: [],
    payloadOf: () => undefined,
  };
}
