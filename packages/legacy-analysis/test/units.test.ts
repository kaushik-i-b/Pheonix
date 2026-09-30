import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeJavaFile, analyzeRepository, maskSource, splitStatements, type RepositoryAnalysis } from '../src/index.js';

/**
 * A miniature legacy repository exercising every structural signal the analyzer claims to detect.
 * Fixtures are written to a temp directory rather than committed so that the walk, categorisation
 * and path handling are covered by the same test as the extraction itself.
 */

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.7.18</version>
  </parent>
  <properties>
    <java.version>1.8</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.flywaydb</groupId>
      <artifactId>flyway-core</artifactId>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <scope>runtime</scope>
    </dependency>
  </dependencies>
</project>
`;

const PROPERTIES = `spring.datasource.url=jdbc:postgresql://localhost:5432/fixture
spring.datasource.password=hunter2
app.mode=\${APP_MODE:legacy}
`;

const V1 = `CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  account_number VARCHAR(10) NOT NULL,
  balance NUMERIC(18,2) NOT NULL DEFAULT 0
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  amount NUMERIC(18,2) NOT NULL
);

CREATE INDEX ledger_acct_idx ON ledger_entries (account_id);
`;

const V2 = `CREATE OR REPLACE FUNCTION ledger_immutable_fn() RETURNS trigger AS $body$
BEGIN
  RAISE EXCEPTION 'ledger rows cannot be changed';
  RETURN NULL;
END;
$body$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE PROCEDURE ledger_immutable_fn();
`;

const THING = `package com.example.domain;

import javax.persistence.Entity;
import javax.persistence.Table;

@Entity
@Table(name = "accounts")
public class Thing {

    private Long id;
    private String accountNumber;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getAccountNumber() {
        return accountNumber;
    }
}
`;

const REPOSITORY = `package com.example.repo;

import com.example.domain.Thing;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ThingRepository extends JpaRepository<Thing, Long> {

    Thing findByAccountNumber(String accountNumber);
}
`;

const SERVICE = `package com.example.svc;

import com.example.domain.Thing;
import com.example.repo.ThingRepository;
import java.math.BigDecimal;
import java.math.RoundingMode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ThingSvc {

    @Autowired private JdbcTemplate jdbc;
    @Autowired private ThingRepository repo;

    public Thing create(String accountNumber, BigDecimal amount) {
        try {
            jdbc.update("INSERT INTO accounts (account_number, balance) VALUES (?, ?)", accountNumber, amount);
        } catch (Exception e) {
        }
        return repo.findByAccountNumber(accountNumber);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void note(String message) {
        jdbc.update("INSERT INTO ledger_entries (account_id, amount) VALUES (?, ?)", Long.valueOf(1), BigDecimal.ONE);
    }

    public BigDecimal fee(BigDecimal amount) {
        BigDecimal f = amount.multiply(new BigDecimal("0.005")).setScale(2, RoundingMode.HALF_UP);
        if (f.compareTo(new BigDecimal("0.25")) < 0) {
            f = new BigDecimal("0.25");
        }
        return f;
    }

    public String pad(long id) {
        return String.format("%010d", Long.valueOf(id));
    }
}
`;

const SERVICE_OLD = `package com.example.svc;

import java.math.BigDecimal;
import java.math.RoundingMode;

public class ThingSvcOld {

    public BigDecimal fee(BigDecimal amount) {
        BigDecimal f = amount.multiply(new BigDecimal("0.005")).setScale(2, RoundingMode.HALF_EVEN);
        if (f.compareTo(new BigDecimal("0.25")) < 0) {
            f = new BigDecimal("0.25");
        }
        return f;
    }
}
`;

const CONTROLLER = `package com.example.web;

import com.example.domain.Thing;
import com.example.svc.ThingSvc;
import java.math.BigDecimal;
import java.util.Collections;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class Controller {

    @Autowired private ThingSvc svc;

    @PostMapping("/api/things")
    public ResponseEntity<Thing> create(@RequestBody Map<String, Object> body) {
        Thing created = svc.create(String.valueOf(body.get("accountNumber")), new BigDecimal("1.00"));
        return ResponseEntity.ok(created);
    }

    @GetMapping("/api/things")
    public Map<String, Object> listThings() {
        return Collections.emptyMap();
    }

    @GetMapping("/api/things")
    public Map<String, Object> listThingsLegacy() {
        return Collections.emptyMap();
    }

    @GetMapping("/api/things/{id}")
    public Thing get(@PathVariable("id") Long id) {
        return svc.create(String.valueOf(id), BigDecimal.ZERO);
    }

    @RequestMapping("/api/anything")
    public String anything() {
        return "ok";
    }
}
`;

const FILES: Record<string, string> = {
  'pom.xml': POM,
  'src/main/resources/application.properties': PROPERTIES,
  'src/main/resources/db/migration/V1__schema.sql': V1,
  'src/main/resources/db/migration/V2__behaviour.sql': V2,
  'src/main/java/com/example/domain/Thing.java': THING,
  'src/main/java/com/example/repo/ThingRepository.java': REPOSITORY,
  'src/main/java/com/example/svc/ThingSvc.java': SERVICE,
  'src/main/java/com/example/svc/ThingSvcOld.java': SERVICE_OLD,
  'src/main/java/com/example/web/Controller.java': CONTROLLER,
};

const directories: string[] = [];
let root: string;
let analysis: RepositoryAnalysis;

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

beforeAll(() => {
  root = tempDirectory('phoenix-analysis-');
  for (const [relativePath, text] of Object.entries(FILES)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }
  analysis = analyzeRepository({ root, generatedAt: '2026-09-30T00:00:00.000Z' });
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('maskSource', () => {
  it('blanks literal contents while preserving every offset and newline', () => {
    const source = 'String s = "a // b"; /* not a literal */\nint x = 1;\n';
    const scanned = maskSource(source);
    expect(scanned.masked).toHaveLength(source.length);
    expect(scanned.masked).not.toContain('a // b');
    expect(scanned.masked).not.toContain('not a literal');
    expect(scanned.masked).toContain('int x = 1;');
    expect(scanned.lineStarts).toHaveLength(3);
    expect(scanned.literals.map((literal) => literal.value)).toContain('a // b');
  });

  it('does not treat comment markers inside strings as comments', () => {
    const scanned = maskSource('query("SELECT 1"); /* not "a string" */');
    expect(scanned.comments).toHaveLength(1);
    expect(scanned.literals).toHaveLength(1);
  });
});

describe('analyzeJavaFile', () => {
  it('recovers annotation arguments that masking blanked', () => {
    const file = analyzeJavaFile('Controller.java', CONTROLLER);
    const create = file.methods.find((method) => method.name === 'create');
    expect(create?.annotations.map((annotation) => [annotation.name, annotation.arguments])).toContainEqual([
      'PostMapping',
      '"/api/things"',
    ]);
  });

  it('reads annotations written on the declaration line', () => {
    const file = analyzeJavaFile('ThingSvc.java', SERVICE);
    const fields = new Map(file.fields.map((field) => [field.name, field.type]));
    expect(fields.get('jdbc')).toBe('JdbcTemplate');
    expect(fields.get('repo')).toBe('ThingRepository');

    const note = file.methods.find((method) => method.name === 'note');
    expect(note?.annotations.map((annotation) => annotation.arguments)).toEqual([
      'propagation = Propagation.REQUIRES_NEW',
    ]);
  });

  it('does not mistake a statement for a declaration', () => {
    const file = analyzeJavaFile('ThingSvc.java', SERVICE);
    expect(file.methods.map((method) => method.name)).not.toContain('update');
    expect(file.methods.map((method) => method.name)).toContain('fee');
  });
});

describe('splitStatements', () => {
  it('keeps a dollar-quoted function body in one statement', () => {
    const statements = splitStatements(V2);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.raw).toContain('RAISE EXCEPTION');
    expect(statements[0]?.raw).toContain('END;');
    expect(statements[1]?.raw).toContain('CREATE TRIGGER');
  });
});

describe('analyzeRepository', () => {
  it('detects build, language level and frameworks with evidence', () => {
    const build = analysis.repositoryMap.buildSystems.find((system) => system.kind === 'maven');
    expect(build?.manifestPath).toBe('pom.xml');
    expect(build?.dependencies.map((dependency) => dependency.name)).toContain('org.flywaydb:flyway-core');
    expect(analysis.repositoryMap.languages.find((language) => language.name === 'Java')?.declaredLevel).toBe('Java 1.8');

    const springBoot = analysis.repositoryMap.frameworks.find((framework) => framework.name === 'spring-boot');
    expect(springBoot?.version).toBe('2.7.18');
    expect(springBoot?.evidence[0]?.location?.path).toBe('pom.xml');
  });

  it('records secret configuration keys without recording their values', () => {
    const source = analysis.repositoryMap.configuration.find((entry) => entry.path.endsWith('application.properties'));
    const password = source?.keys.find((key) => key.key === 'spring.datasource.password');
    expect(password?.secret).toBe(true);
    expect(password?.value).toBeUndefined();
    expect(source?.keys.find((key) => key.key === 'spring.datasource.url')?.value).toContain('jdbc:postgresql');
    expect(source?.environmentOverrides).toContain('APP_MODE');
  });

  it('extracts every route with its real path, verb and handler', () => {
    const routes = analysis.repositoryMap.httpEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(routes).toContain('POST /api/things');
    expect(routes).toContain('GET /api/things/{id}');
    expect(routes).toContain('GET /api/anything');
    expect(routes.every((route) => route !== 'GET /')).toBe(true);
    expect(analysis.repositoryMap.httpEndpoints.every((endpoint) => endpoint.handler.symbol?.startsWith('Controller#'))).toBe(true);
  });

  it('reports route collisions and undeclared verbs as anomalies', () => {
    const colliding = analysis.repositoryMap.httpEndpoints.filter((endpoint) =>
      endpoint.anomalies.some((anomaly) => anomaly.startsWith('route collides with')),
    );
    expect(colliding).toHaveLength(2);

    const anything = analysis.repositoryMap.httpEndpoints.find((endpoint) => endpoint.path === '/api/anything');
    expect(anything?.anomalies.some((anomaly) => anomaly.includes('no HTTP verb declared'))).toBe(true);
  });

  it('finds schema objects, including behaviour that lives in the database', () => {
    const objects = analysis.repositoryMap.databaseObjects.map((object) => `${object.kind}:${object.name}`);
    expect(objects).toContain('table:accounts');
    expect(objects).toContain('index:ledger_acct_idx');
    expect(objects).toContain('trigger:ledger_immutable');
    expect(objects).toContain('function:ledger_immutable_fn');

    const trigger = analysis.repositoryMap.databaseObjects.find((object) => object.name === 'ledger_immutable');
    expect(trigger?.behavior).toContain('EXECUTE PROCEDURE ledger_immutable_fn');
    const function_ = analysis.repositoryMap.databaseObjects.find((object) => object.name === 'ledger_immutable_fn');
    expect(function_?.behavior).toContain('RAISE EXCEPTION');

    const behaviourMigration = analysis.repositoryMap.migrations.find((migration) => migration.version === '2');
    expect(behaviourMigration?.appliesDatabaseBehavior).toBe(true);
    expect(behaviourMigration?.objectsTouched).toContain('ledger_entries');
    expect(analysis.repositoryMap.migrations.find((migration) => migration.version === '1')?.appliesDatabaseBehavior).toBe(false);
  });

  it('attributes SQL to the method that contains it', () => {
    const access = analysis.repositoryMap.databaseAccess.find((entry) => entry.id.endsWith('ThingSvc.java'));
    expect(access?.mechanism).toBe('jdbc-template');
    expect(access?.tables).toEqual(['accounts', 'ledger_entries']);
    expect(access?.statements.every((statement) => statement.location.startLine !== undefined)).toBe(true);
  });

  it('resolves calls to method granularity, including inherited repository queries', () => {
    const edges = analysis.dependencyMap.edges;
    const has = (from: string, to: string, kind: string): boolean =>
      edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);

    expect(has('method:com.example.web.Controller#create', 'method:com.example.svc.ThingSvc#create', 'calls')).toBe(true);
    expect(has('method:com.example.svc.ThingSvc#create', 'method:com.example.repo.ThingRepository#findByAccountNumber', 'calls')).toBe(true);
    // findById is declared by JpaRepository, not by this project, yet the call still resolves.
    expect(has('method:com.example.repo.ThingRepository#findByAccountNumber', 'table:accounts', 'reads')).toBe(true);
    expect(has('method:com.example.svc.ThingSvc#create', 'table:accounts', 'writes')).toBe(true);
    expect(has('method:com.example.svc.ThingSvc#note', 'table:ledger_entries', 'writes')).toBe(true);
    expect(has('endpoint:POST /api/things', 'method:com.example.web.Controller#create', 'http')).toBe(true);
  });

  it('never invents a call target it cannot resolve', () => {
    const unresolved = analysis.dependencyMap.edges.filter(
      (edge) => edge.kind === 'calls' && !analysis.dependencyMap.nodes.some((node) => node.id === edge.to),
    );
    expect(unresolved).toHaveLength(0);
  });

  it('builds one data flow per route with the tables it really touches', () => {
    const create = analysis.dataFlow.flows.find((flow) => flow.name === 'POST /api/things');
    expect(create?.dataStores).toEqual(['accounts']);
    expect(create?.epistemicStatus).toBe('INFERRED');
    expect(create?.steps.map((step) => step.component)).toContain('method:com.example.svc.ThingSvc#create');
    expect(create?.evidence[0]?.location?.path).toBe('src/main/java/com/example/web/Controller.java');

    // Getters and setters stay in the graph but out of the flow.
    expect(create?.steps.map((step) => step.component)).not.toContain('method:com.example.domain.Thing#getId');

    const ids = analysis.dataFlow.flows.map((flow) => flow.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flags the drifted fee calculation as a duplicated calculation', () => {
    const cluster = analysis.repositoryMap.duplicationClusters.find((entry) =>
      entry.members.some((member) => member.symbol === 'ThingSvc#fee'),
    );
    expect(cluster?.drifted).toBe(true);
    expect(cluster?.members.map((member) => member.symbol)).toContain('ThingSvcOld#fee');
    expect(cluster?.driftEvidence[0]?.quote).toContain('HALF_UP');

    const behavior = analysis.repositoryMap.suspiciousBehaviors.find(
      (entry) => entry.category === 'duplicated-calculation' && entry.description.includes('ThingSvcOld#fee'),
    );
    expect(behavior?.recommendedAction).toBe('differential-scenario');
  });

  it('flags swallowed exceptions, independent transactions and database-side behaviour', () => {
    const categories = analysis.repositoryMap.suspiciousBehaviors.map((entry) => entry.category);
    expect(categories).toContain('swallowed-exception');
    expect(categories).toContain('transaction-boundary-anomaly');
    expect(categories).toContain('db-side-behavior');

    const requiresNew = analysis.repositoryMap.suspiciousBehaviors.find((entry) => entry.description.includes('REQUIRES_NEW'));
    expect(requiresNew?.location.symbol).toBe('note');
    expect(requiresNew?.location.startLine).toBeGreaterThan(0);

    expect(analysis.repositoryMap.suspiciousBehaviors.every((entry) => entry.location.startLine !== undefined)).toBe(true);
  });

  it('does not report digits inside string literals as magic numbers', () => {
    const magic = analysis.repositoryMap.suspiciousBehaviors.filter((entry) => entry.category === 'magic-number');
    expect(magic.some((entry) => entry.description.includes('%010d'))).toBe(false);
    expect(magic.some((entry) => entry.description.includes(' 010;'))).toBe(false);
  });

  it('marks nondeterministic external dependencies', () => {
    const jdbc = analysis.repositoryMap.externalDependencies.find((entry) => entry.name === 'jdbc');
    expect(jdbc?.kind).toBe('database');
    expect(analysis.repositoryMap.externalDependencies.find((entry) => entry.name === 'jdbc-url')?.usedBy[0]?.path).toBe(
      'src/main/resources/application.properties',
    );
  });

  it('is deterministic: the same input produces the same artifacts', () => {
    const again = analyzeRepository({ root, generatedAt: '2026-09-30T00:00:00.000Z' });
    expect(JSON.stringify(again.repositoryMap)).toBe(JSON.stringify(analysis.repositoryMap));
    expect(JSON.stringify(again.dependencyMap)).toBe(JSON.stringify(analysis.dependencyMap));
    expect(JSON.stringify(again.dataFlow)).toBe(JSON.stringify(analysis.dataFlow));
  });

  it('reports truncation instead of silently returning a partial inventory', () => {
    const truncated = analyzeRepository({ root, maxFiles: 3, generatedAt: '2026-09-30T00:00:00.000Z' });
    expect(truncated.truncated).toBe(true);
    expect(truncated.repositoryMap.ignoredPaths.some((path) => path.includes('truncated'))).toBe(true);
  });
});
