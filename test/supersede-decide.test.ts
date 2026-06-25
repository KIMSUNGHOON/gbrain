/**
 * PR-4 / W4.1 — deterministic supersede decider (pure unit). Conservative bias:
 * ambiguity ⇒ independent. θ=null (disabled-until-calibrated) ⇒ always independent (inert).
 */
import { describe, test, expect } from 'bun:test';
import { decideSupersede, type SupersedeCandidate, type SupersedeInput } from '../src/core/facts/supersede-decide.ts';

const v = (...xs: number[]) => new Float32Array(xs);
const E1 = v(1, 0, 0);
const E1_DUP = v(1, 0, 0);          // cosine 1.0 with E1
const E1_NEAR = v(0.999, 0.045, 0); // cosine ~0.999 with E1 (≥0.97)
const E_ORTH = v(0, 1, 0);          // cosine 0 with E1
const THETA = 0.97;

const OLD = '2026-01-01T00:00:00Z';
const NEW = '2026-06-01T00:00:00Z';

function cand(over: Partial<SupersedeCandidate> = {}): SupersedeCandidate {
  return { id: 1, entity_slug: 'acme', claim_metric: 'mrr', valid_from: OLD, embedding: E1, ...over };
}
function input(over: Partial<SupersedeInput> = {}): SupersedeInput {
  return { entity_slug: 'acme', claim_metric: 'mrr', valid_from: NEW, embedding: E1_DUP, ...over };
}

describe('decideSupersede — inert default (θ disabled-until-calibrated)', () => {
  test('θ=null ⇒ independent even for a perfect match (insert-only)', () => {
    expect(decideSupersede(input(), [cand()], null)).toEqual({ decision: 'independent' });
  });
});

describe('decideSupersede — supersede path', () => {
  test('same entity + same metric + newer + cosine≥θ ⇒ supersede(id)', () => {
    expect(decideSupersede(input(), [cand({ id: 7 })], THETA)).toEqual({ decision: 'supersede', supersedes_id: 7 });
  });
  test('near-but-≥θ cosine still supersedes', () => {
    expect(decideSupersede(input({ embedding: E1_NEAR }), [cand({ id: 9 })], THETA))
      .toEqual({ decision: 'supersede', supersedes_id: 9 });
  });
  test('fallback: input has no claim_metric ⇒ entity + cosine + newer', () => {
    expect(decideSupersede(input({ claim_metric: null }), [cand({ id: 3, claim_metric: null })], THETA))
      .toEqual({ decision: 'supersede', supersedes_id: 3 });
  });
  test('picks the highest-cosine candidate', () => {
    const r = decideSupersede(input(), [
      cand({ id: 1, embedding: E1_NEAR }),
      cand({ id: 2, embedding: E1_DUP }),  // cosine 1.0 — wins
    ], THETA);
    expect(r).toEqual({ decision: 'supersede', supersedes_id: 2 });
  });
});

describe('decideSupersede — conservative independents', () => {
  test('cosine < θ ⇒ independent', () => {
    expect(decideSupersede(input({ embedding: E_ORTH }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('different metric ⇒ independent (different claim)', () => {
    expect(decideSupersede(input({ claim_metric: 'arr' }), [cand({ claim_metric: 'mrr' })], THETA))
      .toEqual({ decision: 'independent' });
  });
  test('input has metric, candidate has none ⇒ independent', () => {
    expect(decideSupersede(input({ claim_metric: 'mrr' }), [cand({ claim_metric: null })], THETA))
      .toEqual({ decision: 'independent' });
  });
  test('not newer (older or equal valid_from) ⇒ independent', () => {
    expect(decideSupersede(input({ valid_from: OLD }), [cand({ valid_from: OLD })], THETA))
      .toEqual({ decision: 'independent' });
    expect(decideSupersede(input({ valid_from: OLD }), [cand({ valid_from: NEW })], THETA))
      .toEqual({ decision: 'independent' });
  });

  // S5 (v0.42.50.0) — embedder-down fail-closed at the DECIDER. A destructive
  // supersede must never fire on a fact whose embedding couldn't be computed
  // (embedder unreachable). This is the unit complement to the structural pin in
  // embedder-down-fail-modes.test.ts (runPipelineWithBody also guards on
  // f.embedding before reaching the decider). (A full pipeline behavioral test
  // is not a meaningful surface: turn-extracted facts carry no valid_from, so
  // the decider returns independent there regardless of the embedder — see the
  // null-valid_from case below.)
  test('input with NULL embedding ⇒ independent (embedder-down fact cannot supersede)', () => {
    expect(decideSupersede(input({ embedding: null }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('candidate with NULL embedding is skipped ⇒ independent', () => {
    expect(decideSupersede(input(), [cand({ embedding: null })], THETA)).toEqual({ decision: 'independent' });
  });
  test('input with null valid_from ⇒ independent (no comparable recency)', () => {
    expect(decideSupersede(input({ valid_from: null }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('different entity ⇒ independent', () => {
    expect(decideSupersede(input({ entity_slug: 'widgetco' }), [cand({ entity_slug: 'acme' })], THETA))
      .toEqual({ decision: 'independent' });
  });
  test('no input embedding ⇒ independent', () => {
    expect(decideSupersede(input({ embedding: null }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('no entity_slug ⇒ independent', () => {
    expect(decideSupersede(input({ entity_slug: null }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('candidate missing embedding is skipped ⇒ independent', () => {
    expect(decideSupersede(input(), [cand({ embedding: null })], THETA)).toEqual({ decision: 'independent' });
  });
  test('unparseable valid_from ⇒ independent', () => {
    expect(decideSupersede(input({ valid_from: 'not-a-date' }), [cand()], THETA)).toEqual({ decision: 'independent' });
  });
  test('no candidates ⇒ independent', () => {
    expect(decideSupersede(input(), [], THETA)).toEqual({ decision: 'independent' });
  });
  test('Date objects (not strings) work for valid_from', () => {
    expect(decideSupersede(input({ valid_from: new Date(NEW) }), [cand({ valid_from: new Date(OLD) })], THETA))
      .toEqual({ decision: 'supersede', supersedes_id: 1 });
  });
});
