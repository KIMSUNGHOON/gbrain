/**
 * v0.42.48.0 (PR-7 / W7.1) — facts-write routing invariant (no-bypass Barrier 3).
 *
 * The verifier substrate's Gate 2 (the fact-grain strict-throw) lives INSIDE
 * the single private chokepoint `runPipelineWithBody` in
 * `src/core/facts/backstop.ts`. The whole gate is only sound if EVERY fact-write
 * entrypoint funnels through that one function — a new exported write path that
 * calls the engine directly would silently bypass the gate.
 *
 * `runPipelineWithBody` had ZERO covering tests before this file. These are
 * STRUCTURAL (source-text) assertions — deliberately no DB — so they are cheap,
 * fast, and fail the instant someone adds a bypass. The behavioral funnel +
 * envelope coverage lives in the DB-backed acceptance suites
 * (strict-rollback-zero-rows / gate2-facts-write).
 *
 * The companion `scripts/check-system-of-record.sh` bans direct
 * `engine.insertFact(s)` writes outside a `gbrain-allow-direct-insert:` allowlist;
 * this test pins the allowlist CENSUS so the set can't quietly grow.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const BACKSTOP = join(REPO, 'src', 'core', 'facts', 'backstop.ts');

describe('W7.1 — runPipelineWithBody is the single facts-write chokepoint', () => {
  const src = readFileSync(BACKSTOP, 'utf-8');

  test('exactly ONE definition of runPipelineWithBody', () => {
    const defs = src.match(/function runPipelineWithBody\s*\(/g) ?? [];
    expect(defs.length).toBe(1);
  });

  test('runPipelineWithBody is PRIVATE (not exported) — callers cannot skip it', () => {
    // A would-be bypass that exports the inner body would surface here.
    expect(src).not.toMatch(/export\s+(async\s+)?function runPipelineWithBody/);
    expect(src).not.toMatch(/export\s+(async\s+)?function runPipeline\b/);
  });

  test('the only exported write entrypoints both funnel into runPipelineWithBody', () => {
    // The exported surface of backstop.ts. A NEW exported write path that does
    // not route through runPipelineWithBody breaks this allowlist.
    const exportedFns = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]).sort();
    expect(exportedFns).toEqual(['__resetBackstopWarningsForTests', 'runFactsBackstop', 'runFactsPipeline']);

    // runFactsPipeline → runPipelineWithBody (direct); runPipeline (private,
    // reached by runFactsBackstop) → runPipelineWithBody. Both bodies must
    // mention the chokepoint.
    const runFactsPipelineBody = sliceFn(src, 'runFactsPipeline');
    expect(runFactsPipelineBody).toMatch(/runPipelineWithBody\s*\(/);
    const runPipelineBody = sliceFn(src, 'runPipeline');
    expect(runPipelineBody).toMatch(/runPipelineWithBody\s*\(/);

    // runFactsBackstop (the put_page / sync entry) must reach runPipeline on
    // both its inline and queued branches — i.e. it never writes facts itself.
    const runFactsBackstopBody = sliceFn(src, 'runFactsBackstop');
    expect(runFactsBackstopBody).toMatch(/runPipeline\s*\(/);
    expect(runFactsBackstopBody).not.toMatch(/\bengine\.insertFacts?\s*\(/);
  });

  test('the Gate-2 permission_denied throw sits ABOVE both direct-insert fallbacks (post-gate, not bypass)', () => {
    const lines = src.split('\n');
    const gateLine = lines.findIndex(l => l.includes("'permission_denied'") || l.includes('permission_denied'));
    expect(gateLine).toBeGreaterThan(-1);
    const insertLines = lines
      .map((l, i) => ({ l, i }))
      .filter(x => /engine\.insertFacts?\s*\(/.test(x.l) && x.l.includes('gbrain-allow-direct-insert'))
      .map(x => x.i);
    expect(insertLines.length).toBe(2); // the two legacy fallbacks
    for (const i of insertLines) {
      expect(i).toBeGreaterThan(gateLine); // fallback runs AFTER the gate throws
    }
  });
});

describe('W7.1 — allowlisted direct-insert census (must not silently grow)', () => {
  test('exactly the known 7 marked engine.insertFact(s) sites exist in src/', () => {
    // grep every marked direct fact-write across src/. The set is a deliberate,
    // reviewed allowlist (each site's trust justification is in its comment):
    //   - cycle/extract-facts.ts (dream-cycle reconcile, remote:false)
    //   - facts/fence-write.ts   (markdown-first reconcile, post-fence-commit)
    //   - facts/backstop.ts x2   (legacy + stub-guard fallbacks, POST Gate-2)
    //   - commands/extract-conversation-facts.ts x2 (bulk + terminal audit row)
    //   - eval/longmemeval/extract.ts (ephemeral benchmark PGLite, no brain repo)
    // A NEW untrusted direct writer must be reviewed, not slipped in.
    const out = execFileSync('bash', ['-c',
      `grep -rEn "engine\\.insertFacts?\\(" "${join(REPO, 'src')}" | grep "gbrain-allow-direct-insert" || true`,
    ], { encoding: 'utf-8' });
    const hits = out.split('\n').filter(Boolean);
    expect(hits.length).toBe(7);

    const files = new Set(hits.map(h => h.split(':')[0].replace(REPO + '/', '')));
    expect([...files].sort()).toEqual([
      'src/commands/extract-conversation-facts.ts',
      'src/core/cycle/extract-facts.ts',
      'src/core/facts/backstop.ts',
      'src/core/facts/fence-write.ts',
      'src/eval/longmemeval/extract.ts',
    ]);
  });
});

/**
 * Crude function-body slicer: from the declaration of `name` to the next
 * top-level `export ` or `async function ` at column 0 (good enough to scope
 * the "does this function mention X" assertions without a TS parser).
 */
function sliceFn(src: string, name: string): string {
  const declRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = declRe.exec(src);
  if (!m) return '';
  const start = m.index;
  const rest = src.slice(start + m[0].length);
  // Next top-level function/export declaration begins the next slice.
  const nextRe = /\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|\nexport\s+(?:interface|type|const)\s/;
  const nm = nextRe.exec(rest);
  return nm ? rest.slice(0, nm.index) : rest;
}
