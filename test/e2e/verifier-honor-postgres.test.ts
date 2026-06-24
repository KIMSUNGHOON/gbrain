/**
 * PR-2 / W2.2 — honor-time verifier resolution on POSTGRES (dual-engine parity).
 *
 * The PGLite behavioral coverage lives in test/verifier-honor.test.ts; this file pins the
 * SAME fail-closed contract against a real Postgres engine, exercising the engine-agnostic
 * `verifier_receipts` 4-tuple lookup (executeRaw) end-to-end. Skipped when DATABASE_URL
 * is unset (run with: DATABASE_URL=postgres://… bun test test/e2e/verifier-honor-postgres.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { buildContentAddress } from '../../src/core/verifier-receipt.ts';
import { resolveVerifierVerdict } from '../../src/core/verifier-honor.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

const HEAD = 'a'.repeat(64);
const OLD_CONFIG = 'b'.repeat(64);
const MODEL = 'm'.repeat(64);
const TARGET = 't'.repeat(64);
const RUN_SHA = 'r'.repeat(64);

const deposit = operationsByName['deposit_verifier_receipt'];
function addr(config_sha: string): string {
  return buildContentAddress({ config_sha, model_sha: MODEL, target_sha: TARGET, run_sha: RUN_SHA });
}

d('W2.2 honor-time resolution (Postgres)', () => {
  let depositCtx: OperationContext;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    const engine = await setupDB();
    depositCtx = { engine, remote: false } as unknown as OperationContext;
    savedEnv = process.env.GBRAIN_VERIFIER_CONFIG_SHA;
  });
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.GBRAIN_VERIFIER_CONFIG_SHA;
    else process.env.GBRAIN_VERIFIER_CONFIG_SHA = savedEnv;
    await teardownDB();
  });
  beforeEach(async () => {
    process.env.GBRAIN_VERIFIER_CONFIG_SHA = HEAD;
    await getEngine().executeRaw('DELETE FROM verifier_receipts', []);
  });

  async function depositReceipt(config_sha: string, verdict: string): Promise<void> {
    await deposit.handler(depositCtx, {
      config_sha, model_sha: MODEL, target_sha: TARGET, run_sha: RUN_SHA, verdict, receipt_json: {},
    });
  }
  const goodClaim = () => ({ verifier_receipt: { id: addr(HEAD), model_sha: MODEL, target_sha: TARGET, run_sha: RUN_SHA } });

  test('deposited PASS + current HEAD + matching identity → pass', async () => {
    await depositReceipt(HEAD, 'pass');
    expect(await resolveVerifierVerdict(getEngine(), goodClaim()))
      .toEqual({ verdict: 'pass', contentAddress: addr(HEAD) });
  });

  test('absent row → undefined', async () => {
    expect(await resolveVerifierVerdict(getEngine(), goodClaim())).toBeUndefined();
  });

  test('FAIL verdict → undefined', async () => {
    await depositReceipt(HEAD, 'fail');
    expect(await resolveVerifierVerdict(getEngine(), goodClaim())).toBeUndefined();
  });

  test('stale-config replay → undefined (old-config id mismatches HEAD; no HEAD row exists)', async () => {
    await depositReceipt(OLD_CONFIG, 'pass');
    expect(await resolveVerifierVerdict(getEngine(), {
      verifier_receipt: { id: addr(OLD_CONFIG), model_sha: MODEL, target_sha: TARGET, run_sha: RUN_SHA },
    })).toBeUndefined();
    expect(await resolveVerifierVerdict(getEngine(), goodClaim())).toBeUndefined();
  });

  test('no HEAD config → undefined even with a deposited PASS', async () => {
    await depositReceipt(HEAD, 'pass');
    delete process.env.GBRAIN_VERIFIER_CONFIG_SHA;
    expect(await resolveVerifierVerdict(getEngine(), goodClaim())).toBeUndefined();
  });
});
