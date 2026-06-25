/**
 * PR-5 / W5.1 — `verified_by` provenance column persists through both engine write paths
 * (scalar insertFact + batch insertFacts), engine-agnostic. Value = verifier receipt
 * content-address id (null for unverified writes). PGLite is authoritative; the SQL shape is
 * mirrored byte-for-byte on Postgres (engine-parity).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

async function readVerifiedBy(id: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ verified_by: string | null }>(
    'SELECT verified_by FROM facts WHERE id = $1', [id],
  );
  return rows[0]?.verified_by ?? null;
}
const RECEIPT = 'a'.repeat(64);

describe('W5.1 — verified_by persists via insertFact (scalar)', () => {
  test('a verified write records the receipt id', async () => {
    const r = await engine.insertFact(
      { fact: 'Acme shipped Gate 2.', source: 'cli:test', verified_by: RECEIPT },
      { source_id: 'default' },
    );
    expect(await readVerifiedBy(r.id)).toBe(RECEIPT);
  });

  test('an unverified write leaves verified_by null', async () => {
    const r = await engine.insertFact(
      { fact: 'Acme shipped something else.', source: 'cli:test' },
      { source_id: 'default' },
    );
    expect(await readVerifiedBy(r.id)).toBeNull();
  });

  test('supersede path ({supersedeId}) also carries verified_by', async () => {
    const old = await engine.insertFact({ fact: 'MRR is 50k.', source: 'cli:test' }, { source_id: 'default' });
    const neu = await engine.insertFact(
      { fact: 'MRR is 60k.', source: 'cli:test', verified_by: RECEIPT },
      { source_id: 'default', supersedeId: old.id },
    );
    expect(neu.status).toBe('superseded');
    expect(await readVerifiedBy(neu.id)).toBe(RECEIPT);
  });
});

describe('W5.1 — verified_by persists via insertFacts (batch / fence path)', () => {
  test('batch write records the receipt id', async () => {
    const res = await engine.insertFacts(
      [
        { fact: 'Batch fact one.', source: 'sync:import', verified_by: RECEIPT, row_num: 1, source_markdown_slug: 'wiki/acme' },
        { fact: 'Batch fact two.', source: 'sync:import', row_num: 2, source_markdown_slug: 'wiki/acme' },
      ],
      { source_id: 'default' },
    );
    expect(res.ids.length).toBe(2);
    expect(await readVerifiedBy(res.ids[0])).toBe(RECEIPT);
    expect(await readVerifiedBy(res.ids[1])).toBeNull();
  });
});

describe('W5.3 — verified facts survive deleteFactsForPage (re-sync survival)', () => {
  async function exists(id: number): Promise<boolean> {
    const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE id = $1', [id]);
    return rows.length > 0;
  }

  test('verified row survives a page re-sync; unverified control is wiped', async () => {
    const res = await engine.insertFacts(
      [
        { fact: 'Verified durable claim.', source: 'mcp:extract_facts', verified_by: RECEIPT, source_markdown_slug: 'wiki/resync', row_num: 1 },
        { fact: 'Unverified control claim.', source: 'mcp:extract_facts', source_markdown_slug: 'wiki/resync', row_num: 2 },
      ],
      { source_id: 'default' },
    );
    const [verifiedId, controlId] = res.ids;
    const del = await engine.deleteFactsForPage('wiki/resync', 'default');
    expect(del.deleted).toBe(1);                       // only the unverified control
    expect(await readVerifiedBy(verifiedId)).toBe(RECEIPT); // verified survived
    expect(await exists(controlId)).toBe(false);        // control gone
  });

  test('verified_by survives N consecutive re-syncs', async () => {
    const res = await engine.insertFacts(
      [{ fact: 'N-sync durable.', source: 'mcp:extract_facts', verified_by: RECEIPT, source_markdown_slug: 'wiki/durable', row_num: 1 }],
      { source_id: 'default' },
    );
    for (let i = 0; i < 3; i++) await engine.deleteFactsForPage('wiki/durable', 'default');
    expect(await readVerifiedBy(res.ids[0])).toBe(RECEIPT);
  });

  test('the excludeSourcePrefixes carve-out still also protects cli: facts', async () => {
    const res = await engine.insertFacts(
      [
        { fact: 'cli conversation fact.', source: 'cli:think', source_markdown_slug: 'wiki/mixed', row_num: 1 },
        { fact: 'plain fence fact.', source: 'mcp:put_page', source_markdown_slug: 'wiki/mixed', row_num: 2 },
      ],
      { source_id: 'default' },
    );
    const del = await engine.deleteFactsForPage('wiki/mixed', 'default', { excludeSourcePrefixes: ['cli:'] });
    expect(del.deleted).toBe(1);                 // only the mcp:put_page fence row
    expect(await exists(res.ids[0])).toBe(true);  // cli: survived
    expect(await exists(res.ids[1])).toBe(false); // fence row wiped
  });
});

describe('W5.3 — re-insert interaction with a surviving verified row (latent; inert by default)', () => {
  async function exists2(id: number): Promise<boolean> {
    const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE id = $1', [id]);
    return rows.length > 0;
  }
  test('a re-extract at a fresh row_num coexists with the surviving verified row', async () => {
    const a = await engine.insertFacts([{ fact: 'Verified at row 1.', source: 'mcp:extract_facts', verified_by: RECEIPT, source_markdown_slug: 'wiki/coexist', row_num: 1 }], { source_id: 'default' });
    await engine.deleteFactsForPage('wiki/coexist', 'default');                 // verified survives
    const b = await engine.insertFacts([{ fact: 'New at row 2.', source: 'mcp:extract_facts', source_markdown_slug: 'wiki/coexist', row_num: 2 }], { source_id: 'default' });
    expect(b.ids.length).toBe(1);
    expect(await exists2(a.ids[0])).toBe(true);  // verified row still there
    expect(await exists2(b.ids[0])).toBe(true);  // new row inserted
  });
  test('re-insert at the SAME row_num as a surviving verified row collides (idx_facts_fence_key) — known latent, contained in the cycle reconcile (extract-facts.ts try/catch)', async () => {
    await engine.insertFacts([{ fact: 'Verified at row 5.', source: 'mcp:extract_facts', verified_by: RECEIPT, source_markdown_slug: 'wiki/collide', row_num: 5 }], { source_id: 'default' });
    await engine.deleteFactsForPage('wiki/collide', 'default');                 // verified survives at row 5
    await expect(
      engine.insertFacts([{ fact: 'Collision at row 5.', source: 'mcp:extract_facts', source_markdown_slug: 'wiki/collide', row_num: 5 }], { source_id: 'default' }),
    ).rejects.toThrow();  // pins the latent collision; the cycle path contains it, the fast-follow makes the reconcile row_num-aware
  });
});
