/**
 * verifier-honor — Stage 2 honor-time validation (PR-2 / W2.2).
 *
 * The transport layer (stdio MCP, OAuth HTTP MCP) calls `resolveVerifierVerdict` BEFORE
 * dispatch when a request carries a `verifier_receipt` claim. The claim is an OPAQUE
 * handle (a content-address the caller obtained from the verifier) plus the write's
 * identity fields. Honor-time validation independently re-derives the receipt's
 * content-address from the CURRENT verifier config (`HEAD`, server-supplied — the caller
 * cannot influence it) and the write's claimed identity, then confirms a matching PASS
 * receipt was actually deposited.
 *
 * FAIL-CLOSED is the whole contract: a FAIL / inconclusive verdict, a stale-config
 * receipt (deposited under a different `config_sha` than the current HEAD), a
 * field-mismatch (the presented id doesn't bind to this write + config), an absent row,
 * a missing claim, or any error ALL collapse to `undefined`. `undefined` is injected as
 * `ctx.verifierVerdict` unset, which a consuming Gate (Stage 3 / W3.1) treats as
 * "verification did not pass". The carrier never fabricates a pass — the ONLY way to get
 * `{ verdict: 'pass' }` back is a deposited, current-config, identity-bound PASS receipt.
 *
 * Replay-binding falls straight out of `buildContentAddress`: an old run's PASS lives at
 * a DIFFERENT address (different run_sha) and a previous config's PASS lives at a
 * DIFFERENT address (different config_sha === old HEAD), so neither can be presented to
 * authorize a write at the current HEAD.
 */
import type { BrainEngine } from './engine.ts';
import { buildContentAddress, type VerifierVerdict } from './verifier-receipt.ts';

/** The honored verdict carrier injected onto `OperationContext.verifierVerdict`. */
export interface HonoredVerdict {
  verdict: VerifierVerdict;
  contentAddress: string;
}

/**
 * The current verifier-config sha in force at honor time ("HEAD"). The verifier process
 * (or the operator) sets `GBRAIN_VERIFIER_CONFIG_SHA` to the full-width sha256 of the
 * active verifier config; a deposited receipt is only honorable when its `config_sha`
 * equals this value. This is the server-side trust anchor — it is NEVER read from the
 * request, so a caller cannot downgrade to (or replay) an old config.
 *
 * Returns `null` when unset/blank, in which case NO receipt is honorable and every
 * verifier-backed write fails closed. That is the safe default until an operator wires
 * the verifier config; normal (non-verifier) ops are unaffected.
 */
export function resolveHeadConfigSha(): string | null {
  const raw = process.env.GBRAIN_VERIFIER_CONFIG_SHA;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A well-formed `verifier_receipt` claim extracted from the request arguments. */
interface VerifierClaim {
  id: string;
  model_sha: string;
  target_sha: string;
  run_sha: string;
}

/**
 * Extract + shape-validate the opaque `verifier_receipt` claim from request arguments.
 * Returns `null` for "no claim" and for any malformed claim (treated identically — both
 * mean "no verifier verdict to honor"). Untrusted input: every field must be a
 * non-empty string or the claim is rejected.
 */
function extractClaim(params: Record<string, unknown> | undefined): VerifierClaim | null {
  const raw = params?.verifier_receipt;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  const model_sha = obj.model_sha;
  const target_sha = obj.target_sha;
  const run_sha = obj.run_sha;
  if (
    typeof id !== 'string' || id.trim().length === 0 ||
    typeof model_sha !== 'string' || model_sha.trim().length === 0 ||
    typeof target_sha !== 'string' || target_sha.trim().length === 0 ||
    typeof run_sha !== 'string' || run_sha.trim().length === 0
  ) {
    return null;
  }
  return { id, model_sha, target_sha, run_sha };
}

/**
 * Honor-time resolution: returns `{ verdict: 'pass', contentAddress }` ONLY when the
 * request's `verifier_receipt` claim resolves to a deposited PASS receipt whose
 * content-address binds to the current HEAD config AND the write's identity. Any other
 * outcome (no claim, malformed claim, no HEAD config, address mismatch, missing row,
 * non-pass verdict, DB error) returns `undefined` — fail-closed.
 *
 * The `engine` is passed directly (not via OperationContext) because resolution happens
 * at the transport BEFORE the dispatcher builds the context; the result is then threaded
 * in as `DispatchOpts.verifierVerdict`.
 */
export async function resolveVerifierVerdict(
  engine: BrainEngine,
  params: Record<string, unknown> | undefined,
): Promise<HonoredVerdict | undefined> {
  const claim = extractClaim(params);
  if (!claim) return undefined; // no (well-formed) verifier claim → normal unverified op

  const headConfigSha = resolveHeadConfigSha();
  if (!headConfigSha) return undefined; // no config anchor → nothing is honorable

  // Re-derive the content-address from server-supplied HEAD config + the write's claimed
  // identity. This is the binding check: the caller-presented opaque id MUST equal what
  // a receipt for (THIS config, THIS write) would be addressed at. A stale-config or
  // wrong-write id fails here.
  const expectedAddress = buildContentAddress({
    config_sha: headConfigSha,
    model_sha: claim.model_sha,
    target_sha: claim.target_sha,
    run_sha: claim.run_sha,
  });
  if (claim.id !== expectedAddress) return undefined; // forged / stale / mis-bound → fail-closed

  // Confirm a matching receipt was actually deposited with a PASS verdict. Looked up by
  // the (config_sha, model_sha, target_sha, run_sha) UNIQUE key — the same 4-tuple the
  // address was derived from, so HEAD-config + identity equality hold by construction.
  let rows: Array<{ verdict: string }>;
  try {
    rows = await engine.executeRaw<{ verdict: string }>(
      `SELECT verdict FROM verifier_receipts
       WHERE config_sha = $1 AND model_sha = $2 AND target_sha = $3 AND run_sha = $4
       LIMIT 1`,
      [headConfigSha, claim.model_sha, claim.target_sha, claim.run_sha],
    );
  } catch {
    // Table absent (un-migrated brain) or query failure → fail-closed, never throw into
    // the request path. A verifier-backed write simply proceeds unverified (Stage-3 Gate
    // will deny it); normal ops never reach here.
    return undefined;
  }

  if (rows.length !== 1) return undefined; // no deposited receipt for this identity
  if (rows[0].verdict !== 'pass') return undefined; // FAIL / inconclusive cannot authorize

  return { verdict: 'pass', contentAddress: expectedAddress };
}
