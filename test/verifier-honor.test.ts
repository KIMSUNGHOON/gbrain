/**
 * PR-2 / W2.2 — honor-time verifier resolution (PGLite behavioral).
 *
 * `resolveVerifierVerdict` only returns `{ verdict: 'pass', contentAddress }` when the
 * request's `verifier_receipt` claim resolves to a DEPOSITED PASS receipt whose
 * content-address binds to the CURRENT HEAD config AND the write's identity. Every other
 * outcome — no claim, malformed claim, no HEAD config, address mismatch (forged/stale),
 * missing row, FAIL/inconclusive verdict — collapses to `undefined` (fail-closed).
 *
 * The lookup SQL is engine-agnostic (executeRaw, 4-tuple UNIQUE key); v118 parity is
 * pinned by test/e2e/schema-drift.test.ts so the same logic holds on Postgres.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildContentAddress } from '../src/core/verifier-receipt.ts';
import { resolveVerifierVerdict, resolveHeadConfigSha } from '../src/core/verifier-honor.ts';

let engine: PGLiteEngine;
let depositCtx: OperationContext;
const deposit = operationsByName['deposit_verifier_receipt'];

const HEAD = 'a'.repeat(64);
const OLD_CONFIG = 'b'.repeat(64);
const MODEL = 'm'.repeat(64);
const TARGET = 't'.repeat(64);
const RUN = 'r'.repeat(64);

/** content-address a receipt would have for (config, MODEL, TARGET, RUN). */
function addr(config_sha: string): string {
  return buildContentAddress({ config_sha, model_sha: MODEL, target_sha: TARGET, run_sha: RUN });
}

/** A well-formed claim that, under HEAD config, points at (MODEL, TARGET, RUN). */
function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verifier_receipt: {
      id: addr(HEAD),
      model_sha: MODEL,
      target_sha: TARGET,
      run_sha: RUN,
      ...overrides,
    },
  };
}

async function depositReceipt(config_sha: string, run_sha: string, verdict: string): Promise<void> {
  await deposit.handler(depositCtx, {
    config_sha, model_sha: MODEL, target_sha: TARGET, run_sha,
    verdict, receipt_json: {},
  });
}

let savedEnv: string | undefined;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // v118 verifier_receipts
  depositCtx = { engine, remote: false } as unknown as OperationContext;
  savedEnv = process.env.GBRAIN_VERIFIER_CONFIG_SHA;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.GBRAIN_VERIFIER_CONFIG_SHA;
  else process.env.GBRAIN_VERIFIER_CONFIG_SHA = savedEnv;
  await engine.disconnect();
});
beforeEach(async () => {
  // Default: HEAD config is set. Individual tests override/clear as needed.
  process.env.GBRAIN_VERIFIER_CONFIG_SHA = HEAD;
  // Per-test isolation: deposits are immutable (ON CONFLICT DO NOTHING) and accumulate
  // across tests, so wipe the carrier table between tests to keep identities clean.
  await engine.executeRaw('DELETE FROM verifier_receipts', []);
});

describe('resolveHeadConfigSha (W2.2 config anchor)', () => {
  test('returns the env value when set', () => {
    process.env.GBRAIN_VERIFIER_CONFIG_SHA = HEAD;
    expect(resolveHeadConfigSha()).toBe(HEAD);
  });
  test('returns null when unset or blank (→ nothing is honorable)', () => {
    delete process.env.GBRAIN_VERIFIER_CONFIG_SHA;
    expect(resolveHeadConfigSha()).toBeNull();
    process.env.GBRAIN_VERIFIER_CONFIG_SHA = '   ';
    expect(resolveHeadConfigSha()).toBeNull();
  });
});

describe('resolveVerifierVerdict — PASS path', () => {
  test('deposited PASS + current HEAD + matching id/identity → { verdict: pass, contentAddress }', async () => {
    await depositReceipt(HEAD, RUN, 'pass');
    const v = await resolveVerifierVerdict(engine, claim());
    expect(v).toEqual({ verdict: 'pass', contentAddress: addr(HEAD) });
  });
});

describe('resolveVerifierVerdict — fail-closed branches (→ undefined)', () => {
  test('no claim at all', async () => {
    expect(await resolveVerifierVerdict(engine, {})).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, undefined)).toBeUndefined();
  });

  test('malformed claim: missing fields / wrong types / empty strings / array', async () => {
    await depositReceipt(HEAD, RUN, 'pass'); // a valid receipt exists, yet malformed claims still fail
    expect(await resolveVerifierVerdict(engine, { verifier_receipt: {} })).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, { verifier_receipt: { id: addr(HEAD) } })).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, claim({ id: '' }))).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, claim({ model_sha: 123 }))).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, claim({ run_sha: '   ' }))).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, { verifier_receipt: [addr(HEAD)] })).toBeUndefined();
    expect(await resolveVerifierVerdict(engine, { verifier_receipt: null })).toBeUndefined();
  });

  test('no HEAD config (env unset) → even a perfect claim is unhonorable', async () => {
    await depositReceipt(HEAD, RUN, 'pass');
    delete process.env.GBRAIN_VERIFIER_CONFIG_SHA;
    expect(await resolveVerifierVerdict(engine, claim())).toBeUndefined();
  });

  test('absent row: well-formed, id matches HEAD-derived address, but nothing deposited', async () => {
    // fresh identity (different run) that we never deposit
    const freshRun = 'f'.repeat(64);
    const freshAddr = buildContentAddress({ config_sha: HEAD, model_sha: MODEL, target_sha: TARGET, run_sha: freshRun });
    const v = await resolveVerifierVerdict(engine, {
      verifier_receipt: { id: freshAddr, model_sha: MODEL, target_sha: TARGET, run_sha: freshRun },
    });
    expect(v).toBeUndefined();
  });

  test('FAIL verdict cannot authorize', async () => {
    const failRun = 'g'.repeat(64);
    await depositReceipt(HEAD, failRun, 'fail');
    const failAddr = buildContentAddress({ config_sha: HEAD, model_sha: MODEL, target_sha: TARGET, run_sha: failRun });
    const v = await resolveVerifierVerdict(engine, {
      verifier_receipt: { id: failAddr, model_sha: MODEL, target_sha: TARGET, run_sha: failRun },
    });
    expect(v).toBeUndefined();
  });

  test('inconclusive verdict cannot authorize', async () => {
    const incRun = 'h'.repeat(64);
    await depositReceipt(HEAD, incRun, 'inconclusive');
    const incAddr = buildContentAddress({ config_sha: HEAD, model_sha: MODEL, target_sha: TARGET, run_sha: incRun });
    const v = await resolveVerifierVerdict(engine, {
      verifier_receipt: { id: incAddr, model_sha: MODEL, target_sha: TARGET, run_sha: incRun },
    });
    expect(v).toBeUndefined();
  });

  test('forged id: claim id does NOT equal the HEAD-derived address → reject before DB', async () => {
    await depositReceipt(HEAD, RUN, 'pass');
    const v = await resolveVerifierVerdict(engine, claim({ id: 'deadbeef'.repeat(8) }));
    expect(v).toBeUndefined();
  });

  test('a raw verdict:"pass" field in the claim is inert — authorization derives from the DEPOSITED row, never the claim', async () => {
    // No receipt deposited (beforeEach wiped the table). The claim is well-formed
    // (id binds to HEAD) AND screams verdict:'pass'/status:'pass'. resolveVerifierVerdict
    // reads the DB by content-address; the claim's own verdict field carries zero weight
    // → undefined. A Generator cannot vouch for itself by shaping the claim blob.
    const v = await resolveVerifierVerdict(engine, claim({ verdict: 'pass', status: 'pass', result: 'pass' }));
    expect(v).toBeUndefined();
  });

  test('stale config replay: a PASS deposited under an OLD config cannot authorize at the new HEAD', async () => {
    // Deposit a PASS under OLD_CONFIG for the same (MODEL, TARGET, RUN).
    await depositReceipt(OLD_CONFIG, RUN, 'pass');
    // HEAD is the (different) current config. Presenting the OLD-config address:
    //   id (= addr(OLD_CONFIG)) !== addr(HEAD) → rejected at the binding check.
    const vOldId = await resolveVerifierVerdict(engine, claim({ id: addr(OLD_CONFIG) }));
    expect(vOldId).toBeUndefined();
    // Presenting the HEAD address binds correctly but no row exists at (HEAD, …) → absent.
    const vHeadId = await resolveVerifierVerdict(engine, claim()); // id = addr(HEAD), but only OLD_CONFIG row exists
    expect(vHeadId).toBeUndefined();
  });
});
