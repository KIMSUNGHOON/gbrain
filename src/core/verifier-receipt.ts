/**
 * verifier-receipt — Stage 1 carrier substrate (PR-1 / W1.2).
 *
 * A VerifierReceipt is the identity of a verification OUTPUT, content-addressed by the
 * 4-tuple (config_sha, model_sha, target_sha, run_sha) — full-width sha256 per input.
 * `buildContentAddress` canonicalizes the tuple (fixed role order) and hashes it, yielding
 * the deterministic id stored as the `verifier_receipts` UNIQUE key (migration v118) and,
 * later, as `facts.verified_by` (W5.1). Two verifications of the SAME identity collapse to
 * one address (idempotent deposit via ON CONFLICT DO NOTHING — W1.4); a different
 * config/model/target/run yields a DIFFERENT address (replay-binding: an old or other run's
 * PASS cannot be reused to authorize a write).
 */
import { createHash } from 'node:crypto';

export type VerifierVerdict = 'pass' | 'fail' | 'inconclusive';

/** The 4-tuple that content-addresses a verification output (each a full-width sha256). */
export interface VerifierReceiptIdentity {
  config_sha: string;
  model_sha: string;
  target_sha: string;
  run_sha: string;
}

export interface VerifierReceipt extends VerifierReceiptIdentity {
  verdict: VerifierVerdict;
  /** cd_score (the verifier's composite score); null/absent for fail/inconclusive without a score. */
  cd_score?: number | null;
  /** Full receipt blob — stored raw in JSONB so `replay` can reconstruct without the disk artifact. */
  receipt_json: Record<string, unknown>;
}

/**
 * Full-width sha256 content-address over the 4-tuple identity. The tuple has FIXED role
 * order (config, model, target, run), so it is serialized in that order — NOT sorted.
 * (Sorting-before-hashing is only for unordered SET inputs, e.g. a model set hashed
 * upstream into `model_sha`; the tuple itself is positional.) Newline-joined so one sha
 * cannot smear into its neighbor. Returns the full 64-char hex digest (no truncation) so
 * the address space matches the `verifier_receipts` UNIQUE key.
 */
export function buildContentAddress(id: VerifierReceiptIdentity): string {
  const canonical = [id.config_sha, id.model_sha, id.target_sha, id.run_sha].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
