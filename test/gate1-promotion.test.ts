/**
 * PR-3 / W3.1 + W3.2 — Stage 3 Gate 1 (boundary authorization) acceptance.
 *
 * The Gate 1 predicate lives in `dispatchToolCall` (before op.handler) so it fires on every
 * remote transport identically. For a remote mutating `scope:'write'` op it (W3.2) enforces
 * write authority on the requested target source, and (W3.1) requires a `visibility:'world'`
 * promotion-class write to carry BOTH the `shared_write` capability AND a server-injected
 * verifier PASS verdict — fail-closed. Trusted local CLI (`remote:false`) is structurally
 * excluded.
 *
 * Driven through `extract_facts` (the canonical write+mutating op with a `visibility` param).
 * Facts extraction is disabled via the kill switch so ALLOW cases short-circuit to a clean
 * `extraction_disabled` envelope without an LLM call — we assert the GATE decision (deny vs
 * pass-through), not the handler's downstream behavior. Engine-agnostic (pure predicate logic
 * over ctx); PGLite coverage is authoritative.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Kill switch ON: extract_facts short-circuits to {skipped:'extraction_disabled'} so a
  // gate-ALLOW case never makes an LLM call. Gate-DENY cases throw before the handler anyway.
  await engine.setConfig('facts.extraction_enabled', 'false');
});
afterAll(async () => { await engine.disconnect(); });

function errCode(r: Awaited<ReturnType<typeof dispatchToolCall>>): string | null {
  if (!r.isError) return null;
  try { return (JSON.parse(r.content[0]?.text ?? '{}') as { error?: string }).error ?? null; }
  catch { return null; }
}
function auth(scopes: string[], sourceId = 'personal-a'): AuthInfo {
  return { token: 'tok', clientId: 'client', scopes, sourceId } as AuthInfo;
}
const PASS = { verdict: 'pass' as const, contentAddress: 'a'.repeat(64) };
const call = (params: Record<string, unknown>, opts: DispatchOpts) =>
  dispatchToolCall(engine, 'extract_facts', { turn_text: 'I shipped the verifier gate today.', ...params }, opts);

describe('W3.1 — promotion-class (visibility:world) requires shared_write AND a PASS verdict', () => {
  test('★ world write, NO verdict (shared_write present) → permission_denied (fail-closed, 0 side-effect)', async () => {
    const r = await call({ visibility: 'world' }, { remote: true, auth: auth(['write', 'shared_write']) });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('world write, verdict=pass but NO shared_write → permission_denied', async () => {
    const r = await call({ visibility: 'world' }, { remote: true, auth: auth(['write']), verifierVerdict: PASS });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('world write, FAIL verdict (not pass) + shared_write → permission_denied', async () => {
    const r = await call({ visibility: 'world' }, {
      remote: true, auth: auth(['write', 'shared_write']),
      verifierVerdict: { verdict: 'fail', contentAddress: 'b'.repeat(64) },
    });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('world write, inconclusive verdict + shared_write → permission_denied', async () => {
    const r = await call({ visibility: 'world' }, {
      remote: true, auth: auth(['write', 'shared_write']),
      verifierVerdict: { verdict: 'inconclusive', contentAddress: 'c'.repeat(64) },
    });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('admin does NOT satisfy shared_write — world write with admin + verdict=pass → permission_denied', async () => {
    const r = await call({ visibility: 'world' }, { remote: true, auth: auth(['admin']), verifierVerdict: PASS });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('stdio (no auth) world write → permission_denied (DEFAULT_LOCAL_PIPE_SCOPES lacks shared_write)', async () => {
    const r = await call({ visibility: 'world' }, { remote: true, verifierVerdict: PASS });
    expect(errCode(r)).toBe('permission_denied');
  });

  test('✓ world write WITH shared_write + verdict=pass → gate passes (handler runs)', async () => {
    const r = await call({ visibility: 'world' }, { remote: true, auth: auth(['write', 'shared_write']), verifierVerdict: PASS });
    expect(errCode(r)).not.toBe('permission_denied');
    expect(r.isError).toBeFalsy();
  });
});

describe('W3.1 — non-promotion writes are unaffected', () => {
  test('private write (visibility omitted) needs no verdict/shared_write → gate passes', async () => {
    const r = await call({}, { remote: true, auth: auth(['write']) });
    expect(errCode(r)).not.toBe('permission_denied');
  });

  test('explicit private visibility → gate passes', async () => {
    const r = await call({ visibility: 'private' }, { remote: true, auth: auth(['write']) });
    expect(errCode(r)).not.toBe('permission_denied');
  });

  test('CLI (remote:false) world write bypasses Gate 1 entirely (no verdict, no shared_write)', async () => {
    const r = await call({ visibility: 'world' }, { remote: false });
    expect(errCode(r)).not.toBe('permission_denied');
  });
});

describe('W3.2 — resolveWriteScope: write authority on the target source', () => {
  test('remote write to a cross-source source_id (≠ write authority) → permission_denied', async () => {
    const r = await call(
      { visibility: 'private', source_id: 'shared:domain-x' },
      { remote: true, auth: auth(['write', 'shared_write'], 'personal-a'), verifierVerdict: PASS },
    );
    expect(errCode(r)).toBe('permission_denied');
  });

  test('remote write to OWN source_id (= write authority) → gate passes', async () => {
    const r = await call(
      { visibility: 'private', source_id: 'personal-a' },
      { remote: true, auth: auth(['write'], 'personal-a') },
    );
    expect(errCode(r)).not.toBe('permission_denied');
  });

  test('promotion to OWN shared source: source_id = write authority + world + shared_write + verdict → passes', async () => {
    const r = await call(
      { visibility: 'world', source_id: 'shared:domain-x' },
      { remote: true, auth: auth(['write', 'shared_write'], 'shared:domain-x'), verifierVerdict: PASS },
    );
    expect(errCode(r)).not.toBe('permission_denied');
    expect(r.isError).toBeFalsy();
  });

  test('CLI (remote:false) writes any source_id → gate passes', async () => {
    const r = await call({ source_id: 'shared:domain-x' }, { remote: false });
    expect(errCode(r)).not.toBe('permission_denied');
  });
});
