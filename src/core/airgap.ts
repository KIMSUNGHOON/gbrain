/**
 * Air-gap mode (PR-6 / Stage 6).
 *
 * Single source of truth for the "is this an on-prem AIR-GAPPED deploy?"
 * decision. Every behavior-changing air-gap lock — engine=postgres requirement
 * (A17), code/config index reject (A18), default-deny egress allowlist (A9),
 * git-host allowlist (A21), thin-client/remote-MCP refusal (A10), self-upgrade
 * off (A4/A5), x-api resolver de-register (A11), url-reachable disable (A12),
 * remote search_by_image block (A22) — gates on `isAirGap()`. When air-gap is
 * OFF (the default, cloud installs), every one of those guards is a pure no-op:
 * default installs are byte-for-byte unaffected.
 *
 * Resolution (fail-safe OR — a lockdown flag must be HARD to turn off):
 *
 *     air-gap ON  iff  env GBRAIN_AIRGAP ∈ {1, true}  OR  config.airgap.enabled === true
 *
 * There is deliberately NO env value that DISABLES air-gap once config enables
 * it (no `GBRAIN_AIRGAP=0` kill-switch): a security lockdown should never carry
 * an env override an attacker-with-env-control could flip to re-open egress.
 * The flag is fail-closed — anything not strictly the two truthy forms above is
 * treated as "not air-gap via env" and falls through to the config field
 * (default false), mirroring the `OperationContext.remote` trust pattern.
 *
 * Readable at EVERY altitude. Critically, the no-arg form self-loads via the
 * synchronous `loadConfig()` (file + env plane, NOT the DB plane), so it gives
 * the SAME answer at pre-engine boot (e.g. `engine-factory.ts`, where no engine
 * handle exists yet) and at runtime. Reading the DB plane would split the
 * answer across altitudes and let a runtime DB write flip the posture
 * inconsistently — neither is acceptable for a deploy-wide security mode.
 *
 * Convention (matches `src/core/feature-flags.ts`): this module is the ONLY
 * place that reads the flag. Callers go through `isAirGap()` so future changes
 * to the key, default, or backing store happen in one place.
 */
import { loadConfig, type GBrainConfig } from './config.ts';

/** Env master switch. The two truthy forms are the only ways env turns it on. */
function envAirGap(): boolean {
  const v = process.env.GBRAIN_AIRGAP;
  return v === '1' || v === 'true';
}

// The file-plane read is cached: air-gap is a deploy-fixed decision, and the
// no-arg form is called on hot paths (per-file during sync, per-fetch at the
// egress boundary). Env is still re-read live every call (cheap, and it's the
// master switch), so flipping GBRAIN_AIRGAP in a test takes effect immediately
// without a reset.
let fileAirGapCache: boolean | undefined;

/**
 * True iff this process is running in air-gap mode.
 *
 * @param config Optional already-loaded config. Pass it when you have one in
 *   hand (e.g. the CLI dispatch seam) to avoid a redundant file read; the
 *   value is read from `config.airgap.enabled`. Omit it (no arg) on deep
 *   call sites that don't thread config through — the file plane is read once
 *   and cached. Either way, env `GBRAIN_AIRGAP` wins.
 */
export function isAirGap(config?: GBrainConfig | null): boolean {
  if (envAirGap()) return true;
  if (config !== undefined) return config?.airgap?.enabled === true;
  if (fileAirGapCache === undefined) {
    fileAirGapCache = loadConfig()?.airgap?.enabled === true;
  }
  return fileAirGapCache;
}

/** @internal Test-only — clear the cached file-plane air-gap read. */
export function resetAirGapCacheForTests(): void {
  fileAirGapCache = undefined;
}
