/**
 * v0.42.48.0 (PR-7 / W7.4) — check-verifier-cogrant CI gate self-test.
 *
 * The guard enforces that the `verifier` scope is never co-held with a
 * write-class scope (write | shared_write | admin), via two layers:
 *   1. structural — src/core/scope.ts IMPLIES (admin must not imply verifier;
 *      verifier implies only itself);
 *   2. literal — no scope-grant array literal grants both on one line.
 *
 * This self-test is the ONLY thing that exercises the FAIL-CLOSED direction:
 * a too-permissive guard (regex miss) makes the negative cases pass and is
 * caught here; a too-strict guard fails the positive cases.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'check-verifier-cogrant.sh');

function runGate(cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT_PATH], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, GBRAIN_SCAN_ROOT: cwd },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Write a fake repo with a src/core/scope.ts carrying the given IMPLIES body. */
function fakeRepoWithScope(impliesBody: string, extraFiles: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'cogrant-test-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const scopeDir = join(repo, 'src', 'core');
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    join(scopeDir, 'scope.ts'),
    `export type Scope = 'read' | 'write' | 'admin' | 'verifier' | 'shared_write';\n` +
    `const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {\n${impliesBody}\n};\n`,
    'utf-8',
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return repo;
}

const CLEAN_IMPLIES =
  `  admin: new Set(['admin', 'write', 'read']),\n` +
  `  write: new Set(['write', 'read']),\n` +
  `  read: new Set(['read']),\n` +
  `  verifier: new Set(['verifier']),\n` +
  `  shared_write: new Set(['shared_write']),`;

describe('check-verifier-cogrant.sh — positive (real repo)', () => {
  test('exits 0 on the current repo (verifier is isolated)', () => {
    const r = runGate(join(import.meta.dir, '..'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('verifier scope is isolated');
  });
});

describe('check-verifier-cogrant.sh — structural IMPLIES violations', () => {
  test('clean IMPLIES table exits 0', () => {
    const repo = fakeRepoWithScope(CLEAN_IMPLIES);
    try {
      expect(runGate(repo).code).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('IMPLIES.verifier that implies a write-class scope exits 1', () => {
    const body = CLEAN_IMPLIES.replace(
      `verifier: new Set(['verifier']),`,
      `verifier: new Set(['verifier', 'write']),`,
    );
    const repo = fakeRepoWithScope(body);
    try {
      const r = runGate(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('imply ONLY itself');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('IMPLIES.admin that implies verifier exits 1', () => {
    const body = CLEAN_IMPLIES.replace(
      `admin: new Set(['admin', 'write', 'read']),`,
      `admin: new Set(['admin', 'verifier', 'write', 'read']),`,
    );
    const repo = fakeRepoWithScope(body);
    try {
      const r = runGate(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("must NOT imply 'verifier'");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('check-verifier-cogrant.sh — literal co-grant ban', () => {
  test('a scope-grant array literal granting verifier + write exits 1', () => {
    const repo = fakeRepoWithScope(CLEAN_IMPLIES, {
      'src/grant.ts': `export const tokenScopes = ['verifier', 'write'];\n`,
    });
    try {
      const r = runGate(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('co-grants');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('the same literal with a gbrain-allow-cogrant comment exits 0', () => {
    const repo = fakeRepoWithScope(CLEAN_IMPLIES, {
      'src/grant.ts': `export const tokenScopes = ['verifier', 'write']; // gbrain-allow-cogrant: deliberate test fixture\n`,
    });
    try {
      expect(runGate(repo).code).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

// Regression fixtures for the evasions the adversarial pass found (M1 + S2):
// the guard MUST catch double-quoted and multi-line co-grants, not just the
// single-quoted single-line spelling. Each was a false-negative before the
// quote-class + flatten fix.
describe('check-verifier-cogrant.sh — quote + multi-line evasions (M1/S2 regression)', () => {
  test('DOUBLE-QUOTED IMPLIES.admin implying verifier exits 1 (the M1 false-negative)', () => {
    const body = CLEAN_IMPLIES.replace(
      `admin: new Set(['admin', 'write', 'read']),`,
      `admin: new Set(["admin", "verifier", "write", "read"]),`,
    );
    const repo = fakeRepoWithScope(body);
    try {
      const r = runGate(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("must NOT imply 'verifier'");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('MULTI-LINE IMPLIES.admin implying verifier exits 1', () => {
    const body = CLEAN_IMPLIES.replace(
      `admin: new Set(['admin', 'write', 'read']),`,
      `admin: new Set([\n    'admin',\n    'verifier',\n    'write',\n    'read',\n  ]),`,
    );
    const repo = fakeRepoWithScope(body);
    try {
      const r = runGate(repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("must NOT imply 'verifier'");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('DOUBLE-QUOTED literal co-grant exits 1', () => {
    const repo = fakeRepoWithScope(CLEAN_IMPLIES, {
      'src/grant.ts': `export const tokenScopes = ["verifier", "write"];\n`,
    });
    try {
      expect(runGate(repo).code).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test('MULTI-LINE literal co-grant exits 1', () => {
    const repo = fakeRepoWithScope(CLEAN_IMPLIES, {
      'src/grant.ts': `export const tokenScopes = [\n  'verifier',\n  'write',\n];\n`,
    });
    try {
      expect(runGate(repo).code).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('check-verifier-cogrant.sh — internal error', () => {
  test('exits 2 when src/core/scope.ts is missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cogrant-noscope-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      const r = runGate(repo);
      expect(r.code).toBe(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
