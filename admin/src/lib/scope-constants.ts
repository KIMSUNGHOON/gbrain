/**
 * Admin SPA scope constants — HAND-MAINTAINED MIRROR of src/core/scope.ts.
 *
 * The admin tsconfig.json scopes `include: ['src']` to admin/src/, so we
 * cannot directly import from ../../src/core/scope.ts without breaking the
 * SPA's compile boundary. Instead, this file is a hand-maintained duplicate;
 * scripts/check-admin-scope-drift.sh fails the build if the two lists drift.
 *
 * If you change ALLOWED_SCOPES in src/core/scope.ts, update this file too,
 * or `bun run verify` will reject the change.
 */

export type Scope =
  | 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin' | 'agent'
  | 'verifier' | 'shared_write';

// MIRROR OF src/core/scope.ts ALLOWED_SCOPES_LIST — keep alphabetically sorted.
// v0.38: 'agent' added for the submit_agent remote-MCP op (sibling to admin,
// NOT implied — existing admin clients must re-register to opt in).
// PR-1 / W1.3: 'verifier' (deposit-only) + 'shared_write' added — both non-admin-implied
// siblings (same opt-in rule as 'agent').
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = [
  'admin',
  'agent',
  'read',
  'shared_write',
  'sources_admin',
  'users_admin',
  'verifier',
  'write',
];
