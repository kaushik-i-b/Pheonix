import { describe, expect, it } from 'vitest';
import { getByPath, leafPaths, substitute } from '../src/index.js';

/**
 * Substitution is what lets a scenario chain its own results, and it is type-preserving on purpose:
 * a payload that sends `"2.50"` where legacy expects `2.50` tests the wrong thing on both systems.
 */

describe('substitute', () => {
  const captured = {
    open: {
      stepId: 'open',
      httpStatus: 201,
      responseBody: { accountId: 'acc-7', limit: 250, holder: { name: 'A. Nother' } },
    },
  };

  it('returns the captured value itself when a string is nothing but a token', () => {
    expect(substitute('{{open.responseBody.limit}}', captured)).toBe(250);
    expect(substitute('{{open.httpStatus}}', captured)).toBe(201);
    expect(substitute('{{open.responseBody}}', captured)).toEqual({
      accountId: 'acc-7',
      limit: 250,
      holder: { name: 'A. Nother' },
    });
  });

  it('interpolates a token that is part of a longer string', () => {
    expect(substitute('/accounts/{{open.responseBody.accountId}}/entries', captured)).toBe(
      '/accounts/acc-7/entries',
    );
    expect(substitute('limit was {{open.responseBody.limit}} at {{open.httpStatus}}', captured)).toBe(
      'limit was 250 at 201',
    );
  });

  it('walks arrays and object keys as well as values', () => {
    const payload = substitute(
      { to: '{{open.responseBody.accountId}}', tags: ['{{open.stepId}}'], '{{open.stepId}}': true },
      captured,
    );
    expect(payload).toEqual({ to: 'acc-7', tags: ['open'], open: true });
  });

  it('stringifies a non-string captured value used as an object key', () => {
    expect(substitute({ '{{open.responseBody.limit}}': 1 }, captured)).toEqual({ '250': 1 });
  });

  it('leaves everything that is not a token alone', () => {
    expect(substitute('plain', captured)).toBe('plain');
    expect(substitute(250, captured)).toBe(250);
    expect(substitute(null, captured)).toBeNull();
    expect(substitute('{{ open.responseBody.limit }}', captured)).toBe(250);
  });

  it('names the reference it could not resolve instead of sending a literal token', () => {
    expect(() => substitute('{{never.captured}}', captured)).toThrowError(/never\.captured/);
  });
});

describe('getByPath', () => {
  const root = { responseBody: { accounts: [{ id: 'a' }, { id: 'b' }], closed: null } };

  it('reads through objects and array indices', () => {
    expect(getByPath(root, 'responseBody.accounts.1.id')).toBe('b');
    expect(getByPath(root, 'responseBody.closed')).toBeNull();
  });

  it('returns undefined for anything not present, including past a null', () => {
    expect(getByPath(root, 'responseBody.closed.deeper')).toBeUndefined();
    expect(getByPath(root, 'responseBody.accounts.9.id')).toBeUndefined();
    expect(getByPath(root, 'responseBody.accounts.id')).toBeUndefined();
    expect(getByPath(root, 'nope')).toBeUndefined();
  });
});

describe('leafPaths', () => {
  it('lists a dotted path for every scalar, keeping empty containers as leaves', () => {
    expect(
      leafPaths({ balance: '10.00', holder: { name: 'A' }, entries: [{ id: 1 }, { id: 2 }], tags: [], meta: {} }, 'responseBody'),
    ).toEqual([
      'responseBody.balance',
      'responseBody.holder.name',
      'responseBody.entries.0.id',
      'responseBody.entries.1.id',
      'responseBody.tags',
      'responseBody.meta',
    ]);
  });

  it('stops at the limit rather than letting one large body swamp the suite', () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index]));
    expect(leafPaths(wide, 'body', 10)).toHaveLength(10);
  });
});
