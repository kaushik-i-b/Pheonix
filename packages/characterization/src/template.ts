/**
 * `{{name.path}}` substitution, so one scenario can chain its own results.
 *
 * A characterization scenario has to be able to say "create an account, then transfer from *that*
 * account" without knowing the identifier the system will mint. Values are therefore captured by
 * name as steps run and referenced by path afterwards.
 *
 * Substitution is type-preserving on purpose: a string that is *only* a token becomes the captured
 * value itself, so `{"amount": "{{transfer.responseBody.amount}}"}` sends a number rather than the
 * string `"2.50"`. A system that rejects one and accepts the other would otherwise be tested with
 * the wrong payload on both sides.
 */

const TOKEN = /^\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.\-]*)\s*\}\}$/;
const TOKEN_ANYWHERE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.\-]*)\s*\}\}/g;

export function substitute<TValue>(value: TValue, captured: Readonly<Record<string, unknown>>): TValue {
  if (typeof value === 'string') return substituteString(value, captured) as TValue;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, captured)) as TValue;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[asKey(key, captured)] = substitute(entry, captured);
    }
    return out as TValue;
  }
  return value;
}

/**
 * A token in key position still resolves, but the result has to be a string: an object key cannot
 * hold the number or object the captured value might be.
 */
function asKey(key: string, captured: Readonly<Record<string, unknown>>): string {
  const substituted = substituteString(key, captured);
  return typeof substituted === 'string' ? substituted : JSON.stringify(substituted);
}

function substituteString(text: string, captured: Readonly<Record<string, unknown>>): string | unknown {
  const whole = TOKEN.exec(text);
  if (whole?.[1] !== undefined) {
    const resolved = getByPath(captured, whole[1]);
    if (resolved === undefined) {
      throw new ReferenceError(`scenario references {{${whole[1]}}}, which no earlier step captured`);
    }
    return resolved;
  }
  return text.replace(TOKEN_ANYWHERE, (_match, path: string) => {
    const resolved = getByPath(captured, path);
    if (resolved === undefined) {
      throw new ReferenceError(`scenario references {{${path}}}, which no earlier step captured`);
    }
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}

/**
 * Reads a dotted path out of a captured value: `transfer.responseBody.amount`, `rows.0.id`.
 * Returns `undefined` for anything not present, including a `null` intermediate.
 */
export function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Every dotted path to a scalar leaf in a value, capped so a large body cannot explode the suite. */
export function leafPaths(value: unknown, prefix = '', limit = 400): string[] {
  const paths: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (paths.length >= limit) return;
    if (Array.isArray(node)) {
      if (node.length === 0) paths.push(path);
      node.forEach((entry, index) => walk(entry, `${path}.${index}`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0) paths.push(path);
      for (const [key, entry] of entries) walk(entry, path.length === 0 ? key : `${path}.${key}`);
      return;
    }
    paths.push(path);
  };
  walk(value, prefix);
  return paths;
}
