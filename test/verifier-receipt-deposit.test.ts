/**
 * PR-1 / W1.4 — deposit_verifier_receipt op acceptance (PGLite behavioral).
 *
 * The engine-agnostic INSERT (executeRawJsonb, ON CONFLICT DO NOTHING) runs identically
 * on Postgres; v118 schema parity is pinned by test/e2e/schema-drift.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildContentAddress } from '../src/core/verifier-receipt.ts';

let engine: PGLiteEngine;
let ctx: OperationContext;
const op = operationsByName['deposit_verifier_receipt'];

const identity = {
  config_sha: 'c'.repeat(64),
  model_sha: 'm'.repeat(64),
  target_sha: 't'.repeat(64),
  run_sha: 'r'.repeat(64),
};

type DepositResult = { content_address: string; verdict: string; inserted: boolean };

async function countReceipts(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM verifier_receipts`, [],
  );
  return rows[0].n;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // applies migrations incl v118 verifier_receipts
  ctx = { engine, remote: false } as unknown as OperationContext; // minimal ctx — the handler only reads ctx.engine
});
afterAll(async () => {
  await engine.disconnect();
});

describe('deposit_verifier_receipt (PR-1 / W1.4)', () => {
  test('op contract: registered, scope=verifier, mutating', () => {
    expect(op).toBeDefined();
    expect(op.scope).toBe('verifier');
    expect(op.mutating).toBe(true);
  });

  test('deposit stores the receipt; returns content_address + inserted:true', async () => {
    const r = await op.handler(ctx, {
      ...identity, verdict: 'pass', cd_score: 0.95, receipt_json: { foo: 'bar' },
    }) as DepositResult;
    expect(r.content_address).toBe(buildContentAddress(identity));
    expect(r.inserted).toBe(true);
    expect(await countReceipts()).toBe(1);
  });

  test('idempotent + IMMUTABLE: re-depositing the same identity (even with a FAIL) is a no-op', async () => {
    const r = await op.handler(ctx, {
      ...identity, verdict: 'fail', cd_score: 0.0, receipt_json: { foo: 'changed' },
    }) as DepositResult;
    expect(r.inserted).toBe(false);          // ON CONFLICT DO NOTHING
    expect(await countReceipts()).toBe(1);   // still one row — not duplicated
    // the original PASS verdict survives — a later FAIL cannot overwrite it
    const rows = await engine.executeRaw<{ verdict: string }>(
      `SELECT verdict FROM verifier_receipts WHERE config_sha = $1 AND run_sha = $2`,
      [identity.config_sha, identity.run_sha],
    );
    expect(rows[0].verdict).toBe('pass');
  });

  test('UNIQUE per identity: a different run_sha is a distinct receipt', async () => {
    const r = await op.handler(ctx, {
      ...identity, run_sha: 'z'.repeat(64), verdict: 'inconclusive', receipt_json: {},
    }) as DepositResult;
    expect(r.inserted).toBe(true);
    expect(await countReceipts()).toBe(2);
  });

  test('invalid verdict is rejected before any write', async () => {
    await expect(op.handler(ctx, {
      ...identity, run_sha: 'q'.repeat(64), verdict: 'maybe', receipt_json: {},
    })).rejects.toThrow();
    expect(await countReceipts()).toBe(2); // unchanged
  });
});
