/**
 * PR-1 / W1.2 — VerifierReceipt content-address builder.
 */
import { describe, test, expect } from 'bun:test';
import { buildContentAddress, type VerifierReceiptIdentity } from '../src/core/verifier-receipt.ts';

describe('buildContentAddress (PR-1 / W1.2)', () => {
  const id: VerifierReceiptIdentity = {
    config_sha: 'a'.repeat(64),
    model_sha: 'b'.repeat(64),
    target_sha: 'c'.repeat(64),
    run_sha: 'd'.repeat(64),
  };

  test('deterministic: same identity → same address', () => {
    expect(buildContentAddress(id)).toBe(buildContentAddress({ ...id }));
  });

  test('full-width sha256 hex (64 chars, no truncation)', () => {
    expect(buildContentAddress(id)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('positional: swapping two roles changes the address (no accidental symmetry)', () => {
    const swapped = { ...id, config_sha: id.model_sha, model_sha: id.config_sha };
    expect(buildContentAddress(swapped)).not.toBe(buildContentAddress(id));
  });

  test('replay-binding: any single input change → a different address', () => {
    const base = buildContentAddress(id);
    expect(buildContentAddress({ ...id, run_sha: 'e'.repeat(64) })).not.toBe(base);
    expect(buildContentAddress({ ...id, config_sha: 'e'.repeat(64) })).not.toBe(base);
    expect(buildContentAddress({ ...id, model_sha: 'e'.repeat(64) })).not.toBe(base);
    expect(buildContentAddress({ ...id, target_sha: 'e'.repeat(64) })).not.toBe(base);
  });

  test('no smear: the delimiter stops adjacent shas colliding via bare concatenation', () => {
    // ('ab','c') vs ('a','bc') would collide if joined without a separator.
    const a = buildContentAddress({ config_sha: 'ab', model_sha: 'c', target_sha: 'x', run_sha: 'y' });
    const b = buildContentAddress({ config_sha: 'a', model_sha: 'bc', target_sha: 'x', run_sha: 'y' });
    expect(a).not.toBe(b);
  });
});
