/**
 * v0.42.48.0 (PR-7 / W7.3) — embedder-down fail modes (doc 27 A16 acceptance).
 *
 * Two opposite policies when the embedder is unreachable, both load-bearing:
 *   - FAIL-OPEN for hot-memory extraction: a fact must NOT be lost just because
 *     the embedder is down — it is written with a NULL embedding (classifier
 *     still ran). Behavioral test below.
 *   - FAIL-CLOSED for supersede: a DESTRUCTIVE supersede (expiring a prior fact)
 *     must NEVER fire without a real cosine check, so a null-embedding fact can
 *     never reach the supersede decider. Pinned structurally (the
 *     `runPipelineWithBody` supersede guard requires `f.embedding`), because a
 *     non-vacuous behavioral test would need a full resolved-entity + candidate
 *     + calibrated-theta + PASS-verdict pipeline just to show it's blocked.
 *
 * The embedder is driven down via the sanctioned `__setEmbedTransportForTests`
 * seam (no mock.module); chat is stubbed deterministically so extraction
 * produces a known fact without a real LLM.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

function chatStubOneFact(factText: string): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact: factText, kind: 'event', entity: null, confidence: 1.0, notability: 'high' }] }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

describe('W7.3 — embedder down: FAIL-OPEN for extraction', () => {
  test('a fact still lands (with NULL embedding) when embedOne throws', async () => {
    const factText = 'acme-example shipped the verifier gate on 2026-06-25.';
    chatStubOneFact(factText);
    // Embedder unreachable: every embed call throws → extract.ts absorbs to NULL.
    __setEmbedTransportForTests(async () => { throw new Error('embedder unreachable (test)'); });

    const ctx: FactsBackstopCtx = {
      engine, sourceId: 'default', sessionId: null, source: 'mcp:extract_facts', mode: 'inline', remote: false,
    };
    await runFactsPipeline('We shipped the verifier gate today.', ctx);

    const rows = await engine.executeRaw<{ fact: string; embedding: unknown }>(
      'SELECT fact, embedding FROM facts WHERE fact = $1', [factText],
    );
    expect(rows.length).toBe(1);           // the fact was NOT lost (fail-open)
    expect(rows[0].embedding).toBeNull();  // ...but carries no embedding
  });
});

describe('W7.3 — embedder down: FAIL-CLOSED for supersede (structural pin)', () => {
  test('the supersede guard in runPipelineWithBody requires f.embedding (a null-embedding fact cannot supersede)', () => {
    const backstop = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'facts', 'backstop.ts'), 'utf-8');
    // The Gate-2 supersede branch only runs when f.embedding is truthy — so a
    // fact written under a down embedder (embedding NULL) can never expire a
    // prior fact. A refactor that drops the `f.embedding &&` clause (allowing a
    // destructive supersede on a null cosine) breaks this assertion.
    const supersedeGuard = backstop
      .split('\n')
      .find(l => /supersedeTheta\s*!=\s*null/.test(l) && /f\.embedding/.test(l));
    expect(supersedeGuard).toBeDefined();
    expect(supersedeGuard).toMatch(/f\.embedding/);
  });
});
