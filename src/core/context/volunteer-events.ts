/**
 * v0.43 (#2095) — context_volunteer_events: the feedback-loop log behind
 * push-based context. One row per page the brain VOLUNTEERED, written
 * fire-and-forget by the volunteer_context op, the retrieval-reflex pointer
 * path (channel 'reflex'), and `gbrain watch` (channel 'watch').
 *
 * "Used" is DERIVED, never written: a volunteered page counts as used when
 * pages.last_retrieved_at > volunteered_at (the existing bumpLastRetrievedAt
 * write-back on get_page/search/query is the open/cite signal). The join is
 * approximate by design — last-retrieved is 5-min throttled (false negatives)
 * and unrelated reads match too (false positives); stats output carries the
 * caveat.
 *
 * Retention: rows older than VOLUNTEER_EVENTS_TTL_DAYS are pruned by the
 * dream cycle's purge phase so conversation-adjacent telemetry never grows
 * unbounded. rationale is a deterministic template string, never raw
 * conversation text.
 */

import type { BrainEngine } from './../engine.ts';

export const VOLUNTEER_EVENTS_TTL_DAYS = 90;

export type VolunteerChannel = 'op' | 'reflex' | 'watch';

export interface VolunteerEventRow {
  source_id: string;
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: VolunteerChannel;
  session_id?: string | null;
  turn?: number | null;
}

/**
 * ONE multi-row parameterized INSERT for a batch of volunteered pages (max 5
 * per call by the volunteer cap) — never per-row awaited INSERTs (up to 5
 * RTTs ≈ 355ms on a cross-region deployment; eng-review D4). Throws on
 * failure; callers run it through the volunteer-events background-work sink
 * with try/catch so logging can never fail the op.
 */
export async function insertVolunteerEvents(
  engine: BrainEngine,
  rows: VolunteerEventRow[],
): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    params.push(
      r.source_id,
      r.slug,
      r.confidence,
      r.match_arm,
      r.rationale,
      r.channel,
      r.session_id ?? null,
      r.turn ?? null,
    );
    const ph = Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`);
    return `(${ph.join(', ')})`;
  });
  await engine.executeRaw(
    `INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

/**
 * 90-day GC, called from the dream cycle's purge phase (mirrors
 * purgeStaleCheckpoints). Best-effort: returns 0 on any failure (pre-v116
 * brains have no table yet).
 */
export async function purgeStaleVolunteerEvents(
  engine: BrainEngine,
  ttlDays = VOLUNTEER_EVENTS_TTL_DAYS,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM context_volunteer_events
         WHERE volunteered_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)],
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
