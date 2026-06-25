/**
 * PR-2 / W2.3 — transport-agnostic scope gate in the shared dispatcher (SECURITY CRUX),
 * plus W2.1 — verifierVerdict plumbing through buildOperationContext.
 *
 * The scope check used to live ONLY in serve-http.ts, so stdio MCP (and any other
 * dispatchToolCall caller) could invoke a write/admin/verifier op with NO scope
 * enforcement. The gate now lives in dispatchToolCall and fires on every untrusted
 * (`remote !== false`) caller, BEFORE op.handler. Trusted local CLI (`remote === false`)
 * still bypasses (the OS is the trust boundary there).
 *
 * Engine-agnostic: the gate is pure scope logic (no SQL), so PGLite coverage is
 * authoritative for both engines.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { dispatchToolCall, buildOperationContext, type DispatchOpts } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { DEFAULT_LOCAL_PIPE_SCOPES } from '../src/core/scope.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

/** error code carried by a ToolResult, or null when the call was NOT an error. */
function errCode(r: Awaited<ReturnType<typeof dispatchToolCall>>): string | null {
  if (!r.isError) return null;
  try { return (JSON.parse(r.content[0]?.text ?? '{}') as { error?: string }).error ?? null; }
  catch { return null; }
}

function auth(scopes: string[]): AuthInfo {
  return { token: 'tok', clientId: 'client', scopes } as AuthInfo;
}

let runSeq = 0;
/** distinct verifier-receipt deposit args each call (avoids ON CONFLICT noise). */
function depositArgs(): Record<string, unknown> {
  runSeq += 1;
  return {
    config_sha: 'c'.repeat(64),
    model_sha: 'm'.repeat(64),
    target_sha: 't'.repeat(64),
    run_sha: String(runSeq).padStart(64, '0'),
    verdict: 'pass',
    receipt_json: {},
  };
}

const call = (name: string, params: Record<string, unknown>, opts: DispatchOpts) =>
  dispatchToolCall(engine, name, params, opts);

describe('W2.3 — trusted local CLI bypasses the gate', () => {
  test('remote:false runs a verifier-scoped op (no scope enforcement)', async () => {
    const r = await call('deposit_verifier_receipt', depositArgs(), { remote: false });
    expect(errCode(r)).not.toBe('insufficient_scope');
    expect(r.isError).toBeFalsy();
  });
});

describe('W2.3 — stdio default (remote:true, no auth) = DEFAULT_LOCAL_PIPE_SCOPES', () => {
  test('default scope set is read/write/admin and does NOT include the siblings', () => {
    expect([...DEFAULT_LOCAL_PIPE_SCOPES].sort()).toEqual(['admin', 'read', 'write']);
    expect(DEFAULT_LOCAL_PIPE_SCOPES).not.toContain('verifier');
    expect(DEFAULT_LOCAL_PIPE_SCOPES).not.toContain('shared_write');
  });

  test('ALLOWS a read op', async () => {
    const r = await call('list_pages', {}, { remote: true });
    expect(errCode(r)).not.toBe('insufficient_scope');
  });

  test('ALLOWS a write op', async () => {
    const r = await call('put_page', { slug: 'w23-stdio-write', content: '---\ntitle: t\n---\nbody' }, { remote: true });
    expect(errCode(r)).not.toBe('insufficient_scope');
  });

  test('ALLOWS an admin op', async () => {
    const r = await call('get_stats', {}, { remote: true });
    expect(errCode(r)).not.toBe('insufficient_scope');
  });

  test('★ DENIES a verifier-scoped op — the bypass W2.3 closes (admin does not imply verifier)', async () => {
    const r = await call('deposit_verifier_receipt', depositArgs(), { remote: true });
    expect(errCode(r)).toBe('insufficient_scope');
  });
});

describe('W2.3 — authenticated remote callers use their granted scopes', () => {
  test('read-only token: ALLOWS read, DENIES write', async () => {
    const ok = await call('list_pages', {}, { remote: true, auth: auth(['read']) });
    expect(errCode(ok)).not.toBe('insufficient_scope');
    const denied = await call('put_page', { slug: 'x', content: 'y' }, { remote: true, auth: auth(['read']) });
    expect(errCode(denied)).toBe('insufficient_scope');
  });

  test('explicit verifier token: ALLOWS the verifier op', async () => {
    const r = await call('deposit_verifier_receipt', depositArgs(), { remote: true, auth: auth(['verifier']) });
    expect(errCode(r)).not.toBe('insufficient_scope');
    expect(r.isError).toBeFalsy();
  });

  test('admin token does NOT satisfy the verifier sibling scope', async () => {
    const r = await call('deposit_verifier_receipt', depositArgs(), { remote: true, auth: auth(['admin']) });
    expect(errCode(r)).toBe('insufficient_scope');
  });

  test('insufficient_scope envelope names the required scope', async () => {
    const r = await call('put_page', { slug: 'x', content: 'y' }, { remote: true, auth: auth(['read']) });
    const body = JSON.parse(r.content[0]!.text) as { error: string; message: string; your_scopes: string[] };
    expect(body.error).toBe('insufficient_scope');
    expect(body.message).toContain("'write'");
    expect(body.your_scopes).toEqual(['read']);
  });
});

describe('W2.1 — verifierVerdict plumbing through buildOperationContext', () => {
  test('copies opts.verifierVerdict onto ctx.verifierVerdict verbatim', () => {
    const verdict = { verdict: 'pass' as const, contentAddress: 'a'.repeat(64) };
    const ctx = buildOperationContext(engine, {}, { verifierVerdict: verdict });
    expect(ctx.verifierVerdict).toEqual(verdict);
  });

  test('undefined when no verdict was resolved (fail-closed default)', () => {
    const ctx = buildOperationContext(engine, {}, { remote: true });
    expect(ctx.verifierVerdict).toBeUndefined();
  });

  // W7.3 — injection-surface negative: the verdict is read ONLY from the
  // server-resolved opts, never from caller-supplied tool params. A client
  // cannot smuggle a PASS through the tool arguments.
  test('a verdict injected via tool PARAMS does NOT reach ctx — only server opts do', () => {
    const forged = { verdict: 'pass' as const, contentAddress: 'f'.repeat(64) };
    const ctx = buildOperationContext(
      engine,
      { verifierVerdict: forged, verifier_verdict: forged } as Record<string, unknown>,
      { remote: true }, // opts carry NO server-resolved verdict
    );
    expect(ctx.verifierVerdict).toBeUndefined();
  });

  test('end-to-end: a world write with the verdict smuggled in tool params is still denied', async () => {
    const forged = { verdict: 'pass', contentAddress: 'f'.repeat(64) };
    const r = await call(
      'extract_facts',
      { turn_text: 'fund-c led the round.', visibility: 'world', verifierVerdict: forged },
      { remote: true, auth: auth(['write', 'shared_write']) }, // NO opts verdict
    );
    expect(errCode(r)).toBe('permission_denied');
  });
});
