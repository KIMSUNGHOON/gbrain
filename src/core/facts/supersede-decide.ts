/**
 * supersede-decide — deterministic, pure, NO-LLM supersession decider (PR-4 / W4.1, Stage 4 Gate 2).
 *
 * In the air-gap verifier flow there is no LLM gateway, so the classifier's `supersede`
 * branch (`classify.ts`) is dead — and A15 disables that branch even when an LLM IS present,
 * so this module is the SOLE producer of a `supersede` decision. Supersession is destructive
 * (it expires the prior row), so the rule is conservative: when in any doubt, return
 * `independent` (keep both rows). The cost asymmetry is deliberate — a false-supersede
 * (silently expiring a still-true fact) is far worse than a missed-supersede (a stale row
 * that a recency-ordered recall already ranks below the newer one).
 *
 *   same entity_slug ∧ same claim_metric ∧ newer valid_from ∧ cosine ≥ θ  ⇒  supersede(matched id)
 *   otherwise                                                              ⇒  independent
 *
 * Fallback for facts with no typed `claim_metric` (the extractor may leave it null): key on
 * `entity_slug + embedding cosine ≥ θ + newer valid_from`.
 *
 * θ (`theta`) is a version-stamped knob SEPARATE from dedup's 0.95, and is
 * **disabled-until-calibrated**: a `null` θ means "not yet calibrated" and the decider
 * returns `independent` unconditionally (insert-only) — so Stage 4 ships buildable-as-inert,
 * never silently superseding before an offline embedder-θ calibration exists.
 *
 * Output shape mirrors `parseClassifierJson`'s `{ decision, supersedes_id }` so it is a
 * drop-in at the `runPipelineWithBody` wiring site (W4.2).
 */
import { cosineSimilarity } from './classify.ts';

/** A prior fact considered as a supersede target. */
export interface SupersedeCandidate {
  id: number;
  entity_slug: string | null;
  claim_metric: string | null;
  valid_from: Date | string | null;
  embedding: Float32Array | null;
}

/** The incoming fact being classified. */
export interface SupersedeInput {
  entity_slug: string | null;
  claim_metric: string | null;
  valid_from: Date | string | null;
  embedding: Float32Array | null;
}

export type SupersedeDecision =
  | { decision: 'supersede'; supersedes_id: number }
  | { decision: 'independent' };

const INDEPENDENT: SupersedeDecision = { decision: 'independent' };

/** Epoch millis for a Date | ISO-string | null; null/unparseable → null (not comparable). */
function ms(v: Date | string | null): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Decide whether `input` supersedes one of `candidates`. Pure + deterministic.
 *
 * @param theta cosine threshold; `null` (disabled-until-calibrated) ⇒ always `independent`.
 */
export function decideSupersede(
  input: SupersedeInput,
  candidates: SupersedeCandidate[],
  theta: number | null,
): SupersedeDecision {
  // Disabled-until-calibrated: no θ ⇒ insert-only (the inert default).
  if (theta == null) return INDEPENDENT;
  // Need an embedding (cosine path) and an entity to match on, and a comparable recency.
  if (!input.embedding || !input.entity_slug) return INDEPENDENT;
  const inputMs = ms(input.valid_from);
  if (inputMs == null) return INDEPENDENT;

  let bestId: number | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c.embedding || !c.entity_slug) continue;
    // Same entity.
    if (c.entity_slug !== input.entity_slug) continue;
    // PRIMARY: same typed claim_metric. FALLBACK (input has no metric): entity + cosine only.
    // If the input carries a metric, the candidate must carry the SAME metric — a different
    // metric is a different claim, never a supersede.
    if (input.claim_metric != null && c.claim_metric !== input.claim_metric) continue;
    // Recency: the input must be strictly NEWER than the candidate (else not an update).
    const candMs = ms(c.valid_from);
    if (candMs == null || inputMs <= candMs) continue;
    // Similarity gate.
    const score = cosineSimilarity(input.embedding, c.embedding);
    if (score < theta) continue;
    if (score > bestScore) { bestScore = score; bestId = c.id; }
  }

  return bestId == null ? INDEPENDENT : { decision: 'supersede', supersedes_id: bestId };
}
