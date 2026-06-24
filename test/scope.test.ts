import { test, expect, describe } from 'bun:test';
import {
  hasScope,
  isScope,
  ALLOWED_SCOPES,
  ALLOWED_SCOPES_LIST,
  assertAllowedScopes,
  InvalidScopeError,
  parseScopeString,
  type Scope,
} from '../src/core/scope.ts';

// ---------------------------------------------------------------------------
// Hierarchy table — admin → all, write → read, sibling non-implication
// ---------------------------------------------------------------------------

describe('hasScope — admin implies all (escape hatch)', () => {
  const all: Scope[] = ['read', 'write', 'admin', 'sources_admin', 'users_admin'];
  for (const required of all) {
    test(`admin → ${required}`, () => {
      expect(hasScope(['admin'], required)).toBe(true);
    });
  }
});

describe('hasScope — write implies read but not admin variants', () => {
  test('write → read', () => {
    expect(hasScope(['write'], 'read')).toBe(true);
  });
  test('write → write', () => {
    expect(hasScope(['write'], 'write')).toBe(true);
  });
  test('write does NOT imply admin', () => {
    expect(hasScope(['write'], 'admin')).toBe(false);
  });
  test('write does NOT imply sources_admin', () => {
    expect(hasScope(['write'], 'sources_admin')).toBe(false);
  });
  test('write does NOT imply users_admin', () => {
    expect(hasScope(['write'], 'users_admin')).toBe(false);
  });
});

describe('hasScope — sibling non-implication for *_admin scopes', () => {
  test('sources_admin → sources_admin only', () => {
    expect(hasScope(['sources_admin'], 'sources_admin')).toBe(true);
    expect(hasScope(['sources_admin'], 'users_admin')).toBe(false);
    expect(hasScope(['sources_admin'], 'write')).toBe(false);
    expect(hasScope(['sources_admin'], 'read')).toBe(false);
    expect(hasScope(['sources_admin'], 'admin')).toBe(false);
  });
  test('users_admin → users_admin only', () => {
    expect(hasScope(['users_admin'], 'users_admin')).toBe(true);
    expect(hasScope(['users_admin'], 'sources_admin')).toBe(false);
    expect(hasScope(['users_admin'], 'write')).toBe(false);
    expect(hasScope(['users_admin'], 'read')).toBe(false);
  });
  test('verifier (PR-1/W1.3) → verifier only; NOT implied by admin or write', () => {
    expect(hasScope(['verifier'], 'verifier')).toBe(true);
    expect(hasScope(['verifier'], 'write')).toBe(false);
    expect(hasScope(['verifier'], 'read')).toBe(false);
    expect(hasScope(['admin'], 'verifier')).toBe(false);   // non-admin-implied sibling
    expect(hasScope(['write'], 'verifier')).toBe(false);
  });
  test('shared_write (PR-1/W1.3) → shared_write only; NOT implied by admin or write', () => {
    expect(hasScope(['shared_write'], 'shared_write')).toBe(true);
    expect(hasScope(['shared_write'], 'write')).toBe(false);
    expect(hasScope(['shared_write'], 'read')).toBe(false);
    // ★ the W1.3 security crux: admin does NOT grant shared_write, so the Gate-1
    // predicate (W3.1) can require it independently — a raw admin/grandfather bearer
    // cannot slip a shared write through.
    expect(hasScope(['admin'], 'shared_write')).toBe(false);
    expect(hasScope(['write'], 'shared_write')).toBe(false);
  });
});

describe('hasScope — read scope', () => {
  test('read → read', () => {
    expect(hasScope(['read'], 'read')).toBe(true);
  });
  test('read does NOT imply write', () => {
    expect(hasScope(['read'], 'write')).toBe(false);
  });
});

describe('hasScope — empty + unknown granted', () => {
  test('empty granted set returns false', () => {
    expect(hasScope([], 'read')).toBe(false);
  });
  test('unknown scope strings ignored gracefully (forward-compat)', () => {
    expect(hasScope(['flying-unicorn'], 'read')).toBe(false);
    expect(hasScope(['flying-unicorn', 'admin'], 'read')).toBe(true); // admin still implies
  });
});

describe('hasScope — multi-grant', () => {
  test('read + sources_admin combo', () => {
    expect(hasScope(['read', 'sources_admin'], 'read')).toBe(true);
    expect(hasScope(['read', 'sources_admin'], 'sources_admin')).toBe(true);
    expect(hasScope(['read', 'sources_admin'], 'write')).toBe(false);
  });
  test('write + sources_admin combo (gstack /setup-gbrain Path 4 token)', () => {
    expect(hasScope(['write', 'sources_admin'], 'read')).toBe(true);
    expect(hasScope(['write', 'sources_admin'], 'write')).toBe(true);
    expect(hasScope(['write', 'sources_admin'], 'sources_admin')).toBe(true);
    expect(hasScope(['write', 'sources_admin'], 'users_admin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F3 invariant: refresh-token requested-subset enforcement uses hasScope.
// Prove the v0.26.9-correct semantics (admin grant CAN refresh down to a
// subset; non-implied scope refresh fails).
// ---------------------------------------------------------------------------

describe('F3 refresh-token subset semantics under hasScope', () => {
  test('admin grant → refresh requesting sources_admin succeeds', () => {
    const granted = ['admin'];
    const requested = ['sources_admin'];
    expect(requested.every(s => hasScope(granted, s))).toBe(true);
  });
  test('admin grant → refresh requesting subset (read+write) succeeds', () => {
    const granted = ['admin'];
    const requested = ['read', 'write'];
    expect(requested.every(s => hasScope(granted, s))).toBe(true);
  });
  test('write grant → refresh requesting admin fails', () => {
    const granted = ['write'];
    const requested = ['admin'];
    expect(requested.every(s => hasScope(granted, s))).toBe(false);
  });
  test('write grant → refresh requesting sources_admin fails', () => {
    const granted = ['write'];
    const requested = ['sources_admin'];
    expect(requested.every(s => hasScope(granted, s))).toBe(false);
  });
  test('sources_admin grant → refresh requesting users_admin fails (sibling axis)', () => {
    const granted = ['sources_admin'];
    const requested = ['users_admin'];
    expect(requested.every(s => hasScope(granted, s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_SCOPES allowlist (D4) — registration-time gate
// ---------------------------------------------------------------------------

describe('ALLOWED_SCOPES — exact list pinned', () => {
  test('contains the 8 canonical scopes (v0.38: agent; PR-1/W1.3: verifier + shared_write)', () => {
    expect(ALLOWED_SCOPES.size).toBe(8);
    expect(ALLOWED_SCOPES.has('read')).toBe(true);
    expect(ALLOWED_SCOPES.has('write')).toBe(true);
    expect(ALLOWED_SCOPES.has('admin')).toBe(true);
    expect(ALLOWED_SCOPES.has('sources_admin')).toBe(true);
    expect(ALLOWED_SCOPES.has('users_admin')).toBe(true);
    expect(ALLOWED_SCOPES.has('agent')).toBe(true);
    expect(ALLOWED_SCOPES.has('verifier')).toBe(true);
    expect(ALLOWED_SCOPES.has('shared_write')).toBe(true);
  });
  test('list is sorted alphabetically (deterministic for wire/drift check)', () => {
    expect([...ALLOWED_SCOPES_LIST]).toEqual([
      'admin',
      'agent',
      'read',
      'shared_write',
      'sources_admin',
      'users_admin',
      'verifier',
      'write',
    ]);
  });
});

describe('isScope', () => {
  test('accepts allowed strings', () => {
    expect(isScope('read')).toBe(true);
    expect(isScope('sources_admin')).toBe(true);
  });
  test('rejects unknown strings', () => {
    expect(isScope('flying-unicorn')).toBe(false);
    expect(isScope('')).toBe(false);
    expect(isScope('READ')).toBe(false); // case-sensitive
  });
});

describe('assertAllowedScopes', () => {
  test('passes for valid set', () => {
    expect(() => assertAllowedScopes(['read', 'sources_admin'])).not.toThrow();
  });
  test('passes for empty', () => {
    expect(() => assertAllowedScopes([])).not.toThrow();
  });
  test('throws InvalidScopeError naming the bad scope', () => {
    try {
      assertAllowedScopes(['read', 'flying-unicorn']);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidScopeError);
      expect((e as InvalidScopeError).invalidScope).toBe('flying-unicorn');
      expect((e as InvalidScopeError).message).toMatch(/flying-unicorn/);
      expect((e as InvalidScopeError).message).toMatch(/Allowed:/);
    }
  });
  test('throws on first invalid scope (short-circuits)', () => {
    try {
      assertAllowedScopes(['flying-unicorn', 'also-bad']);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as InvalidScopeError).invalidScope).toBe('flying-unicorn');
    }
  });
});

describe('parseScopeString', () => {
  test('splits space-separated', () => {
    expect(parseScopeString('read write admin')).toEqual(['read', 'write', 'admin']);
  });
  test('drops empty fragments', () => {
    expect(parseScopeString('read  write')).toEqual(['read', 'write']);
  });
  test('handles undefined/null/empty', () => {
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString(null)).toEqual([]);
    expect(parseScopeString('')).toEqual([]);
  });
  test('does NOT validate (separation of concerns)', () => {
    expect(parseScopeString('read flying-unicorn')).toEqual(['read', 'flying-unicorn']);
  });
});
