/**
 * code-symbol resolver — SKELETON (PR-5 / W5.2, Stage 5 provenance).
 *
 * Maps a fact to a CodeGraph symbol reference, populating the `facts.code_symbol_ref` /
 * `code_symbol_source` / `code_symbol_confidence` columns (migration v120). This file declares
 * the resolver's shape + availability gate ONLY; the production resolve contract (distiller
 * output schema, multi/zero-symbol handling, the actual CodeGraph query) is deferred to doc 30
 * PART B. `available(ctx)` returns true only when a LOCAL CodeGraph index is present, so on a
 * brain with no `.codegraph` the resolver is correctly inert and `resolve()` is never reached.
 *
 * Boundary note: `code_symbol_ref` points at a CodeGraph node — it is ORTHOGONAL to
 * `facts.verified_by` (a verifier-receipt id, never a CodeGraph node).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Resolver, ResolverContext } from './interface.ts';

/** The fact text + resolved entity the resolver keys on. */
export interface CodeSymbolInput {
  factText: string;
  entitySlug?: string | null;
}

/** The three provenance columns the resolver fills. */
export interface CodeSymbolOutput {
  code_symbol_ref: string;
  code_symbol_source: 'codegraph';
  code_symbol_confidence: number;
}

/**
 * Is a local CodeGraph index present? `available()` gates the resolver on this — CodeGraph is
 * a local code-intelligence index (a `.codegraph/` directory at the repo root), and resolution
 * must never leave the host (air-gap). Honors an explicit `codegraph.index_path` config
 * override, else probes `<cwd>/.codegraph`.
 */
export function localCodegraphIndexExists(ctx: ResolverContext): boolean {
  const override = ctx.config['codegraph.index_path'];
  const dir = typeof override === 'string' && override.length > 0
    ? override
    : join(process.cwd(), '.codegraph');
  try { return existsSync(dir); } catch { return false; }
}

export const codeSymbolResolver: Resolver<CodeSymbolInput, CodeSymbolOutput> = {
  id: 'code_symbol_resolve',
  cost: 'free',
  backend: 'codegraph',
  description: 'Resolve a fact to a CodeGraph symbol reference (W5.2 skeleton; resolve deferred to doc 30 PART B).',

  // Available only when a local CodeGraph index exists; otherwise the resolver is inert.
  async available(ctx: ResolverContext): Promise<boolean> {
    return localCodegraphIndexExists(ctx);
  },

  // Deferred: the production resolve contract (CodeGraph query, multi/zero-symbol handling,
  // distiller schema) lands in doc 30 PART B. The registry calls `available()` first, so a
  // brain without a `.codegraph` index never reaches this.
  async resolve(): Promise<never> {
    throw new Error(
      'code_symbol_resolve.resolve is not yet implemented — W5.2 ships the skeleton only; ' +
      'the CodeGraph cross-reference production contract is deferred to doc 30 PART B.',
    );
  },
};
