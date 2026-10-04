/**
 * Which captured values are allowed to be excluded from comparison — and who decides.
 *
 * Normalization is the only place a differential test can be made to pass by hiding something, so
 * the decision is taken away from every agent. A proposed scenario cannot declare a field
 * nondeterministic; there is no field in its vocabulary for doing so. Instead a value is normalized
 * only when two independent things are both true:
 *
 * 1. **It was observed to vary.** The same scenario is executed twice against legacy. A path whose
 *    value is identical in both executions is deterministic, whatever it is called, and is compared.
 * 2. **Its name is one a host policy already classes as uncomparable by construction** — an
 *    identifier minted at runtime, a clock reading, a measured duration. The policy is generic and
 *    domain-neutral: it knows what an `Id` suffix is, not what an account is.
 *
 * Requiring both keeps the error in the safe direction. A balance that shifts between two runs
 * because the scenario mutated shared state varies (fails 1's counterpart) but is not an identifier
 * (fails 2), so it stays in the comparison and the mismatch it causes is *reported*, along with the
 * note that the scenario was not repeatable. A false mismatch costs an investigation; a hidden one
 * costs the entire premise of the run.
 */

/**
 * Leaf names a value must have before observed volatility is allowed to excuse it from comparison.
 * Deliberately suffix- and word-based rather than a list of this system's fields: the same policy
 * has to hold for the next legacy system Phoenix is pointed at.
 */
const RUNTIME_MINTED_LEAF =
  /^(id|uuid|guid|seq|sequence|nonce|pid|time|timestamp|datetime)$/i;

/** `accountId`, `accountNumber`, `transferUuid` — a trailing capitalised identifier suffix. */
const MINTED_SUFFIX = /(Id|Uuid|Guid|Ref|Number|Token|Nonce)$/;

/** `openedAt`, `createdAt`, `settledTime` — a trailing capitalised clock suffix. */
const CLOCK_SUFFIX = /(At|Time)$/;

/** `durationMs`, `elapsedMillis` — a measured interval is a property of the machine, not the logic. */
const DURATION_SUFFIX = /(Ms|Millis|Micros|Nanos)$/;

/**
 * Response headers that describe the transport rather than the answer. These are excluded outright,
 * without probe evidence: two independently written HTTP servers never agree on them, and no
 * reader would call a differing `Content-Length` a behavioral mismatch.
 */
export const TRANSPORT_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'server',
  'via',
  'x-request-id',
  'x-powered-by',
  'set-cookie',
]);

export type NormalizationPolicyVerdict =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

/** Whether host policy would excuse a path *if* it were observed to vary. */
export function normalizationPolicyFor(path: string): NormalizationPolicyVerdict {
  const leaf = path.split('.').filter((segment) => segment.length > 0).at(-1) ?? '';
  if (RUNTIME_MINTED_LEAF.test(leaf)) {
    return { allowed: true, reason: `"${leaf}" is a runtime-minted identifier or clock reading` };
  }
  if (MINTED_SUFFIX.test(leaf)) {
    return { allowed: true, reason: `"${leaf}" ends in an identifier suffix` };
  }
  if (CLOCK_SUFFIX.test(leaf)) {
    return { allowed: true, reason: `"${leaf}" ends in a clock suffix` };
  }
  if (DURATION_SUFFIX.test(leaf)) {
    return { allowed: true, reason: `"${leaf}" ends in a duration suffix` };
  }
  return { allowed: false, reason: `"${leaf}" is not a name host policy classes as uncomparable` };
}

export function isTransportHeader(name: string): boolean {
  return TRANSPORT_RESPONSE_HEADERS.has(name.toLowerCase());
}

/**
 * Decides, from two executions of the same scenario, which paths are nondeterministic.
 *
 * `volatile` is the set of paths whose values differed between the two runs. Every one of them is
 * then put to the policy: a path that varied but is not an identifier or a clock reading is *not*
 * normalized, and is returned in `unexplained` so the report can say the scenario was not
 * repeatable rather than quietly excusing the difference.
 */
export function classifyVolatilePaths(volatile: ReadonlySet<string>): {
  normalizable: Map<string, string>;
  unexplained: string[];
} {
  const normalizable = new Map<string, string>();
  const unexplained: string[] = [];
  for (const path of volatile) {
    const verdict = normalizationPolicyFor(path);
    if (verdict.allowed) normalizable.set(path, verdict.reason);
    else unexplained.push(path);
  }
  return { normalizable, unexplained: unexplained.sort() };
}
