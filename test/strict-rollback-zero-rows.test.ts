/**
 * v0.42.48.0 (PR-7 / W7.3 — strict rollback, 0 NEW rows) acceptance.
 *
 * The literal "strict rollback" claim: when a remote world/supersede fact write
 * is DENIED, the facts table is left EXACTLY as it was — not "an error was
 * thrown" but "zero rows were written." The existing gate suites assert the
 * thrown `permission_denied`; THIS suite adds the row-count probe so a future
 * reordering of the throw to AFTER extraction/insert is caught.
 *
 * Two gates, two entrypoints, one invariant:
 *   - Gate 2 directly via `runFactsPipeline` (the facts-write chokepoint);
 *   - Gate 1 via the full `dispatchToolCall('extract_facts', …)` transport path.
 * Both leave 0 NEW rows on deny.
 *
 * Anti-vacuous: a control insert PROVES the row counter actually detects
 * writes, so "delta 0 on deny" is meaningful and not a blind always-zero.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { OperationError, type AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

async function countFacts(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
  return Number(rows[0]?.n ?? 0);
}

function errCode(r: Awaited<ReturnType<typeof dispatchToolCall>>): string | null {
  if (!r.isError) return null;
  try { return (JSON.parse(r.content[0]?.text ?? '{}') as { error?: string }).error ?? null; }
  catch { return null; }
}

/** Run the Gate-2 chokepoint directly; returns whether permission_denied fired. */
async function pipelineDenied(over: Partial<FactsBackstopCtx>): Promise<boolean> {
  const ctx: FactsBackstopCtx = {
    engine, sourceId: 'default', sessionId: null, source: 'mcp:extract_facts', mode: 'inline', ...over,
  };
  try {
    await runFactsPipeline('Acme raised a Series A from fund-a.', ctx);
    return false;
  } catch (e) {
    return e instanceof OperationError && e.code === 'permission_denied';
  }
}

describe('W7.3 — denied world write leaves 0 NEW facts rows (strict rollback)', () => {
  test('PROBE SANITY: a direct insert increments the counter (proves the probe is not blind)', async () => {
    const before = await countFacts();
    await engine.insertFact({ fact: 'Probe row.', source: 'cli:test' }, { source_id: 'default' });
    expect(await countFacts()).toBe(before + 1);
  });

  test('Gate 2 — remote + world + NO verdict → denied AND 0 new rows', async () => {
    const before = await countFacts();
    expect(await pipelineDenied({ remote: true, visibility: 'world' })).toBe(true);
    expect(await countFacts()).toBe(before); // throw-before-write: zero side-effect
  });

  test('Gate 2 — remote + world + FAIL verdict → denied AND 0 new rows', async () => {
    const before = await countFacts();
    expect(await pipelineDenied({
      remote: true, visibility: 'world',
      verifierVerdict: { verdict: 'fail', contentAddress: 'b'.repeat(64) },
    })).toBe(true);
    expect(await countFacts()).toBe(before);
  });

  test('Gate 1 (full dispatch path) — remote + world + no verdict → isError permission_denied AND 0 new rows', async () => {
    const before = await countFacts();
    const auth: AuthInfo = { token: 'tok', clientId: 'client', scopes: ['write', 'shared_write'], sourceId: 'default' } as AuthInfo;
    const opts: DispatchOpts = { remote: true, auth }; // NO verifierVerdict → fail-closed
    const r = await dispatchToolCall(engine, 'extract_facts', { turn_text: 'fund-b led the round.', visibility: 'world' }, opts);
    expect(r.isError).toBe(true);
    expect(errCode(r)).toBe('permission_denied');
    expect(await countFacts()).toBe(before); // dispatch denies before the handler/backstop writes
  });
});
