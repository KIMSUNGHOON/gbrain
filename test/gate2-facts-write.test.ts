/**
 * PR-4 / W4.3 — Stage 4 Gate 2 (fact-grain strict throw) acceptance.
 *
 * The gate lives in `runPipelineWithBody` (the real facts write chokepoint) and fires BEFORE
 * extraction/any DB write, so a denial has zero side-effect and needs no LLM. A remote
 * (`remote !== false`) `visibility:'world'` write without a verifier PASS verdict is refused;
 * trusted internal callers (`remote: false`) and private writes are exempt — non-breaking.
 *
 * We assert the GATE decision (denied vs passed-through). A passed-through gate then proceeds
 * to extraction, which throws a NON-permission_denied error in a gateway-less test env — that
 * is still "gate passed", which is all this suite checks.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { OperationError } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

const PASS = { verdict: 'pass' as const, contentAddress: 'a'.repeat(64) };

/** 'denied' iff the Gate 2 permission_denied fired; any other outcome (success or a
 * downstream extraction error) means the gate let the write through. */
async function gate(over: Partial<FactsBackstopCtx>): Promise<'denied' | 'passed'> {
  const ctx: FactsBackstopCtx = {
    engine, sourceId: 'default', sessionId: null, source: 'mcp:extract_facts', mode: 'inline', ...over,
  };
  try {
    await runFactsPipeline('Acme raised a Series A.', ctx);
    return 'passed';
  } catch (e) {
    if (e instanceof OperationError && e.code === 'permission_denied') return 'denied';
    return 'passed'; // a non-gate error (e.g. no LLM gateway) means the gate already passed
  }
}

describe('W4.3 — remote world-visibility write requires a PASS verdict', () => {
  test('★ remote + world + NO verdict → denied (fail-closed)', async () => {
    expect(await gate({ remote: true, visibility: 'world' })).toBe('denied');
  });
  test('remote + world + FAIL verdict → denied', async () => {
    expect(await gate({ remote: true, visibility: 'world', verifierVerdict: { verdict: 'fail', contentAddress: 'b'.repeat(64) } })).toBe('denied');
  });
  test('remote undefined (unset) + world + no verdict → denied (remote !== false fail-closed)', async () => {
    expect(await gate({ visibility: 'world' })).toBe('denied');
  });
  test('remote + world + PASS verdict → gate passes', async () => {
    expect(await gate({ remote: true, visibility: 'world', verifierVerdict: PASS })).toBe('passed');
  });
});

describe('W4.3 — exemptions (non-breaking)', () => {
  test('trusted internal (remote:false) + world + no verdict → gate passes (exempt)', async () => {
    expect(await gate({ remote: false, visibility: 'world' })).toBe('passed');
  });
  test('remote + private (visibility omitted) → gate passes', async () => {
    expect(await gate({ remote: true })).toBe('passed');
  });
  test('remote + explicit private → gate passes', async () => {
    expect(await gate({ remote: true, visibility: 'private' })).toBe('passed');
  });
});
