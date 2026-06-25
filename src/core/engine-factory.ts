import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { isAirGap } from './airgap.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  // A17 (v0.42.47.0, PR-6 — BLOCKING): an air-gapped multi-user deploy requires
  // engine='postgres'. PGLite is single-writer and its insertFact path lacks
  // the per-entity `pg_advisory_xact_lock` that Postgres holds around the
  // dedup/supersede window, so concurrent writers on PGLite can race that
  // check. `EngineConfig` carries no air_gap field, so isAirGap() self-loads
  // the file+env plane (the only planes available pre-engine-connect) — the
  // SAME reason the no-arg form exists. NOTE: this intentionally DIVERGES the
  // two engines under the flag; the guard IS the contract. Do not "restore
  // parity" by bolting the advisory lock onto PGLite here.
  if (isAirGap() && engineType !== 'postgres') {
    throw new Error(
      `air-gap mode requires engine='postgres' (got '${engineType}'): PGLite lacks the ` +
      `per-entity advisory locks needed for safe concurrent dedup/supersede. ` +
      `Set engine=postgres (DATABASE_URL=postgres://...).`,
    );
  }

  switch (engineType) {
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine();
    }
    case 'postgres': {
      const { PostgresEngine } = await import('./postgres-engine.ts');
      return new PostgresEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
