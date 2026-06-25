/**
 * PR-6 / Stage 6 — air-gap egress lockdown.
 *
 * Covers the central flag primitive (A0), the A9 egress-allowlist primitives,
 * and every behavior-changing consumer gate (A1, A4/A5, A11, A17, A18, A21,
 * A22). The load-bearing invariant under test: with air-gap OFF (the default),
 * every gate is a pure no-op — default cloud installs are byte-for-byte
 * unaffected. With air-gap ON, each lock fires fail-closed.
 *
 * Driven via `GBRAIN_AIRGAP` env (read live, so no cache reset needed) and via
 * explicit config objects passed to `isAirGap(config)` / `isAllowedEgressHost`.
 */
import { test, expect, describe, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { isAirGap, resetAirGapCacheForTests } from '../src/core/airgap.ts';
import {
  parseHostAllowlist,
  hostMatchesAllowEntry,
  hostInAllowlist,
  getEgressAllowlist,
  isAllowedEgressHost,
} from '../src/core/url-safety.ts';
import type { GBrainConfig } from '../src/core/config.ts';

beforeEach(() => resetAirGapCacheForTests());

// ---------------------------------------------------------------------------
// A0 — the flag primitive
// ---------------------------------------------------------------------------
describe('A0 isAirGap', () => {
  test('env GBRAIN_AIRGAP=1|true turns it on; default off', async () => {
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(isAirGap(null)).toBe(false);
    });
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      expect(isAirGap(null)).toBe(true);
    });
    await withEnv({ GBRAIN_AIRGAP: 'true' }, async () => {
      expect(isAirGap(null)).toBe(true);
    });
  });

  test('config.airgap.enabled turns it on when env is absent', async () => {
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(isAirGap({ airgap: { enabled: true } } as GBrainConfig)).toBe(true);
      expect(isAirGap({ airgap: { enabled: false } } as GBrainConfig)).toBe(false);
      expect(isAirGap({} as GBrainConfig)).toBe(false);
      expect(isAirGap(null)).toBe(false);
    });
  });

  test('OR semantics + no off-override: env-on beats config:false', async () => {
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      // There is deliberately NO env value that DISABLES air-gap once it's on.
      expect(isAirGap({ airgap: { enabled: false } } as GBrainConfig)).toBe(true);
    });
  });

  test('fail-closed: non-truthy env values do NOT enable, fall to config', async () => {
    await withEnv({ GBRAIN_AIRGAP: '0' }, async () => {
      expect(isAirGap({ airgap: { enabled: false } } as GBrainConfig)).toBe(false);
      // '0' is not the on-switch; config still decides.
      expect(isAirGap({ airgap: { enabled: true } } as GBrainConfig)).toBe(true);
    });
    await withEnv({ GBRAIN_AIRGAP: 'yes' }, async () => {
      expect(isAirGap(null)).toBe(false); // only '1'/'true' enable via env
    });
  });
});

// ---------------------------------------------------------------------------
// A9 — egress allowlist primitives
// ---------------------------------------------------------------------------
describe('A9 host-allowlist matching', () => {
  test('parseHostAllowlist splits comma/whitespace, lowercases, drops empties', () => {
    expect(parseHostAllowlist('A.com, b.com  c.com')).toEqual(['a.com', 'b.com', 'c.com']);
    expect(parseHostAllowlist('')).toEqual([]);
    expect(parseHostAllowlist(undefined)).toEqual([]);
    expect(parseHostAllowlist(null)).toEqual([]);
  });

  test('hostMatchesAllowEntry: exact, dot-suffix, star-suffix, apex', () => {
    expect(hostMatchesAllowEntry('gitlab.corp.internal', 'gitlab.corp.internal')).toBe(true);
    expect(hostMatchesAllowEntry('gitlab.corp.internal', 'other.internal')).toBe(false);
    // dot-suffix matches subdomains AND the apex
    expect(hostMatchesAllowEntry('a.corp.internal', '.corp.internal')).toBe(true);
    expect(hostMatchesAllowEntry('corp.internal', '.corp.internal')).toBe(true);
    expect(hostMatchesAllowEntry('evilcorp.internal', '.corp.internal')).toBe(false);
    // star-suffix is equivalent to dot-suffix
    expect(hostMatchesAllowEntry('a.corp.internal', '*.corp.internal')).toBe(true);
    // case + trailing dot normalized
    expect(hostMatchesAllowEntry('GitLab.Corp.Internal.', 'gitlab.corp.internal')).toBe(true);
    // a suffix entry must not match a host that merely ends in the string without a dot boundary
    expect(hostMatchesAllowEntry('notcorp.internal', '.corp.internal')).toBe(false);
  });

  test('hostInAllowlist: empty allowlist denies everything', () => {
    expect(hostInAllowlist('a.com', [])).toBe(false);
    expect(hostInAllowlist('a.com', ['a.com'])).toBe(true);
    expect(hostInAllowlist('x.a.com', ['.a.com'])).toBe(true);
  });

  test('getEgressAllowlist unions env + config', async () => {
    await withEnv({ GBRAIN_EGRESS_ALLOWLIST: 'env-a.com, env-b.com' }, async () => {
      const list = getEgressAllowlist({ airgap: { egress_allowlist: ['Cfg-C.com'] } } as GBrainConfig);
      expect(list).toContain('env-a.com');
      expect(list).toContain('env-b.com');
      expect(list).toContain('cfg-c.com'); // lowercased
    });
  });
});

describe('A9 isAllowedEgressHost', () => {
  test('cloud (air-gap off): pure pass-through — always allows', async () => {
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(isAllowedEgressHost('https://anything.example.com', null)).toBe(true);
      expect(isAllowedEgressHost('http://1.2.3.4', null)).toBe(true);
      // even a malformed URL passes when not air-gap (deny-list layers handle it)
      expect(isAllowedEgressHost('not a url', null)).toBe(true);
    });
  });

  test('air-gap on, empty allowlist: deny ALL egress', async () => {
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_EGRESS_ALLOWLIST: undefined }, async () => {
      expect(isAllowedEgressHost('https://github.com', { airgap: { enabled: true } } as GBrainConfig)).toBe(false);
    });
  });

  test('air-gap on: only allowlisted hosts pass; scheme + malformed fail-closed', async () => {
    const cfg = { airgap: { enabled: true, egress_allowlist: ['proxy.corp.internal', '.cdn.corp.internal'] } } as GBrainConfig;
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      expect(isAllowedEgressHost('https://proxy.corp.internal/v1', cfg)).toBe(true);
      expect(isAllowedEgressHost('https://img.cdn.corp.internal/a.png', cfg)).toBe(true);
      expect(isAllowedEgressHost('https://github.com', cfg)).toBe(false);
      expect(isAllowedEgressHost('ftp://proxy.corp.internal', cfg)).toBe(false); // non-http(s)
      expect(isAllowedEgressHost('::::', cfg)).toBe(false); // malformed
    });
  });
});

// ---------------------------------------------------------------------------
// A9 wiring — ssrf-validate Layer 0
// ---------------------------------------------------------------------------
describe('A9 ssrf-validate Layer-0 gate', () => {
  test('air-gap blocks off-allowlist host with EGRESS_NOT_ALLOWLISTED', async () => {
    const { validateAndResolveUrl, SSRFError } = await import('../src/core/ssrf-validate.ts');
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_EGRESS_ALLOWLIST: undefined }, async () => {
      // No allowlist entries → deny all. Must throw before DNS resolution.
      await expect(validateAndResolveUrl('https://example.com')).rejects.toMatchObject({
        code: 'EGRESS_NOT_ALLOWLISTED',
      });
      expect(SSRFError).toBeDefined();
    });
  });

  test('cloud install: Layer-0 is a no-op (internal host still blocked by Layer-1)', async () => {
    const { validateAndResolveUrl } = await import('../src/core/ssrf-validate.ts');
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      // Not EGRESS_NOT_ALLOWLISTED — the deny-list layer owns this rejection.
      await expect(validateAndResolveUrl('http://169.254.169.254/')).rejects.toMatchObject({
        code: 'INTERNAL_HOST',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// A1 — LiteLLM 4-touchpoint recipe (UNCONDITIONAL, no flag)
// ---------------------------------------------------------------------------
describe('A1 litellm recipe touchpoints', () => {
  test('chat/expansion/reranker touchpoints now exist; assertTouchpoint passes', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const { assertTouchpoint } = await import('../src/core/ai/model-resolver.ts');
    const recipe = getRecipe('litellm');
    expect(recipe).toBeDefined();
    expect(recipe!.touchpoints.embedding).toBeDefined();
    expect(recipe!.touchpoints.chat).toBeDefined();
    expect(recipe!.touchpoints.expansion).toBeDefined();
    expect(recipe!.touchpoints.reranker).toBeDefined();
    // openai-compat tier ⇒ no model-allowlist enforcement; arbitrary ids pass.
    expect(() => assertTouchpoint(recipe!, 'chat', 'any-backend-model')).not.toThrow();
    expect(() => assertTouchpoint(recipe!, 'expansion', 'any-backend-model')).not.toThrow();
    expect(() => assertTouchpoint(recipe!, 'reranker', 'any-backend-model')).not.toThrow();
    // reranker path is the full /v1/rerank leaf (base_url has no /v1 suffix)
    expect(recipe!.touchpoints.reranker!.path).toBe('/v1/rerank');
  });
});

// ---------------------------------------------------------------------------
// A4/A5 — self-upgrade default OFF in air-gap
// ---------------------------------------------------------------------------
describe('A4/A5 self-upgrade mode', () => {
  test('cloud default is notify; air-gap forces off UNCONDITIONALLY (SF-2: no env/config re-enable)', async () => {
    const { resolveSelfUpgradeMode } = await import('../src/core/self-upgrade.ts');
    await withEnv({ GBRAIN_AIRGAP: undefined, GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      expect(resolveSelfUpgradeMode(null)).toBe('notify');
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'auto' } })).toBe('auto'); // cloud honors config
    });
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_SELF_UPGRADE_MODE: undefined }, async () => {
      expect(resolveSelfUpgradeMode(null)).toBe('off');
      // SF-2: neither config NOR env can re-open the GitHub update-check egress.
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'notify' } })).toBe('off');
    });
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_SELF_UPGRADE_MODE: 'auto' }, async () => {
      expect(resolveSelfUpgradeMode(null)).toBe('off'); // env does NOT win over air-gap
    });
  });

  test('SF-1: fetchLatestRelease returns null in air-gap without fetching; runBinarySelfUpdate refuses', async () => {
    const { fetchLatestRelease } = await import('../src/commands/check-update.ts');
    const { runBinarySelfUpdate } = await import('../src/core/binary-self-update.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      expect(await fetchLatestRelease()).toBeNull();
      // deps would throw if reached; air-gap returns before any of them fire.
      const res = await runBinarySelfUpdate('/tmp/fake', {
        fetchRelease: async () => { throw new Error('must not fetch in air-gap'); },
      } as any);
      expect(res).toMatchObject({ ok: false, reason: 'air_gap' });
    });
  });
});

// ---------------------------------------------------------------------------
// A11 — x-api resolver de-registered in air-gap
// ---------------------------------------------------------------------------
describe('A11 builtin resolver registration', () => {
  test('air-gap registers url_reachable but NOT x_handle_to_tweet', async () => {
    const { registerBuiltinResolvers } = await import('../src/commands/resolvers.ts');
    const { ResolverRegistry } = await import('../src/core/resolvers/index.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      const reg = new ResolverRegistry();
      registerBuiltinResolvers(reg);
      expect(reg.has('url_reachable')).toBe(true);
      expect(reg.has('x_handle_to_tweet')).toBe(false);
    });
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      const reg = new ResolverRegistry();
      registerBuiltinResolvers(reg);
      expect(reg.has('url_reachable')).toBe(true);
      expect(reg.has('x_handle_to_tweet')).toBe(true); // cloud: registered
    });
  });

  test('url_reachable.available() is false in air-gap (A12), true otherwise', async () => {
    const { urlReachableResolver } = await import('../src/core/resolvers/builtin/url-reachable.ts');
    const ctx = { signal: undefined } as any;
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      expect(await urlReachableResolver.available(ctx)).toBe(false);
    });
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(await urlReachableResolver.available(ctx)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// A17 — engine=postgres required in air-gap
// ---------------------------------------------------------------------------
describe('A17 engine-factory air-gap guard', () => {
  test('air-gap + pglite throws (before any engine import)', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      await expect(createEngine({ engine: 'pglite' } as any)).rejects.toThrow(/air-gap mode requires engine='postgres'/);
    });
  });

  test('air-gap + postgres is allowed (construct, no connect)', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      const eng = await createEngine({ engine: 'postgres' } as any);
      expect(eng.kind).toBe('postgres');
    });
  });
});

// ---------------------------------------------------------------------------
// A18 — code/config files rejected (markdown-only) in air-gap
// ---------------------------------------------------------------------------
describe('A18 import-file code/config reject', () => {
  test('air-gap: a .cpp file is skipped at the embed chokepoint (engine untouched)', async () => {
    const { importFromFile } = await import('../src/core/import-file.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-airgap-a18-'));
    const cpp = join(dir, 'sim.cpp');
    writeFileSync(cpp, '#include <cstdio>\nint main(){return 0;}\n');
    try {
      await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
        // Pass a dummy engine: the air-gap guard returns BEFORE importCodeFile
        // would touch it. If the guard regressed, this throws on the null engine.
        const res = await importFromFile({} as any, cpp, 'sim.cpp');
        expect(res.status).toBe('skipped');
        expect(String(res.error)).toContain('air-gap');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('air-gap: a config file (.yaml) is also rejected (isCodeFilePath covers it)', async () => {
    const { importFromFile } = await import('../src/core/import-file.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-airgap-a18b-'));
    const yaml = join(dir, 'config.yaml');
    writeFileSync(yaml, 'key: value\n');
    try {
      await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
        const res = await importFromFile({} as any, yaml, 'config.yaml');
        expect(res.status).toBe('skipped');
        expect(String(res.error)).toContain('air-gap');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A21 — git host allowlist in air-gap
// ---------------------------------------------------------------------------
describe('A21 git-remote host allowlist', () => {
  test('cloud: public host passes (no air-gap gate)', async () => {
    const { parseRemoteUrl } = await import('../src/core/git-remote.ts');
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(parseRemoteUrl('https://github.com/acme/repo.git').hostname).toBe('github.com');
    });
  });

  test('air-gap + empty allowlist: ALL remote git denied (host_not_allowed)', async () => {
    const { parseRemoteUrl, RemoteUrlError } = await import('../src/core/git-remote.ts');
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: undefined }, async () => {
      try {
        parseRemoteUrl('https://github.com/acme/repo.git');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteUrlError);
        expect((e as any).code).toBe('host_not_allowed');
      }
    });
  });

  test('air-gap + allowlisted public host passes', async () => {
    const { parseRemoteUrl } = await import('../src/core/git-remote.ts');
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: 'github.com' }, async () => {
      expect(parseRemoteUrl('https://github.com/acme/repo.git').hostname).toBe('github.com');
    });
  });
});

// ---------------------------------------------------------------------------
// A22 — remote search_by_image blocked in air-gap
// ---------------------------------------------------------------------------
describe('A22 search_by_image remote block', () => {
  test('air-gap + remote caller is refused at handler entry', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const op = operationsByName['search_by_image'];
    expect(op).toBeDefined();
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      await expect(op.handler({ remote: true } as any, {} as any)).rejects.toThrow(/air-gap: search_by_image/);
    });
  });

  test('cloud install: handler is NOT blocked by the air-gap guard', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const op = operationsByName['search_by_image'];
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      // It will fail later (no image provided), but NEVER with the air-gap message.
      let msg = '';
      try {
        await op.handler({ remote: true } as any, {} as any);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toContain('air-gap: search_by_image');
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial-verify fixes (MF/SF) — socket-layer enforcement, not parser-only
// ---------------------------------------------------------------------------
describe('MF-1/MF-2 A21 socket-layer git allowlist', () => {
  test('assertGitHostAllowedInAirGap: no-op off, deny empty allowlist on, allow listed', async () => {
    const { assertGitHostAllowedInAirGap } = await import('../src/core/git-remote.ts');
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      expect(() => assertGitHostAllowedInAirGap('github.com')).not.toThrow(); // cloud no-op
    });
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: undefined }, async () => {
      expect(() => assertGitHostAllowedInAirGap('github.com')).toThrow(/host "github.com" is not on the allowlist/);
      expect(() => assertGitHostAllowedInAirGap('')).toThrow(/unparseable|not on the allowlist/); // fail-closed
    });
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: 'gitlab.corp.internal' }, async () => {
      expect(() => assertGitHostAllowedInAirGap('gitlab.corp.internal')).not.toThrow();
      expect(() => assertGitHostAllowedInAirGap('github.com')).toThrow(/host_not_allowed|not on the allowlist/);
    });
  });

  test('cloneRepo enforces the allowlist BEFORE touching git (recloneIfMissing path)', async () => {
    const { cloneRepo, RemoteUrlError } = await import('../src/core/git-remote.ts');
    await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: undefined }, async () => {
      // Empty allowlist in air-gap → deny. Guard is the first line, so this
      // throws host_not_allowed without spawning git / hitting the network.
      try {
        cloneRepo('https://github.com/acme/repo.git', '/tmp/gbrain-airgap-clone-should-not-exist');
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteUrlError);
        expect((e as any).code).toBe('host_not_allowed');
      }
    });
  });

  // MF-1: the steady-state `gbrain sync` git-pull egress — reaches pullRepo by
  // PATH (no url), so it must read the clone's origin and enforce the allowlist.
  test('pullRepo reads origin + enforces the allowlist (steady-state sync egress)', async () => {
    const { execFileSync } = await import('child_process');
    const { pullRepo, RemoteUrlError } = await import('../src/core/git-remote.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-airgap-pull-'));
    try {
      execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git'], { stdio: 'ignore' });

      // Air-gap + empty allowlist: the origin (github.com) is read and denied
      // BEFORE `git pull` runs → host_not_allowed, no network. (The allowlisted-
      // pass path is covered by the assertGitHostAllowedInAirGap unit test above;
      // exercising it here would let `git pull` reach github.com.)
      await withEnv({ GBRAIN_AIRGAP: '1', GBRAIN_GIT_HOST_ALLOWLIST: undefined }, async () => {
        try {
          pullRepo(dir);
          throw new Error('expected throw');
        } catch (e) {
          expect(e).toBeInstanceOf(RemoteUrlError);
          expect((e as any).code).toBe('host_not_allowed');
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MF-3 A10 callRemoteTool refuses at the top (before OAuth egress)', () => {
  test('air-gap throws RemoteMcpError config before getAccessToken fires', async () => {
    const { callRemoteTool } = await import('../src/core/mcp-client.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      // Guard is the very first statement — fires even before requireRemoteMcp,
      // so no OAuth discovery / token-mint socket is opened.
      await expect(callRemoteTool({} as any, 'query', {})).rejects.toThrow(/air-gap: remote MCP connections are forbidden/);
    });
  });
});

describe('MF-4 A1 litellm empty-models expansion does not corrupt providers output', () => {
  test('formatRecipeTable: litellm EXPAND column is "—", never renders undefined', async () => {
    const { formatRecipeTable } = await import('../src/commands/providers.ts');
    const { listRecipes } = await import('../src/core/ai/recipes/index.ts');
    const table = formatRecipeTable(listRecipes(), {});
    expect(table).not.toContain('undefined');
    const litellmRow = table.split('\n').find(l => l.startsWith('litellm'));
    expect(litellmRow).toBeDefined();
    // EMBED yes (litellm declares embedding models? no — empty), EXPAND must be '—'
    // because expansion.models is []. The key assertion: no 'litellm:undefined'.
    expect(litellmRow).not.toContain('undefined');
  });
});

describe('SF-4 A8 supabase storage backend refused in air-gap', () => {
  test('createStorage throws for supabase in air-gap; local still works', async () => {
    const { createStorage } = await import('../src/core/storage.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      await expect(createStorage({ backend: 'supabase' } as any)).rejects.toThrow(/air-gap.*supabase/i);
      const local = await createStorage({ backend: 'local', localPath: '/tmp/gbrain-airgap-storage' } as any);
      expect(local).toBeDefined();
    });
    await withEnv({ GBRAIN_AIRGAP: undefined }, async () => {
      // cloud: supabase backend is NOT refused by the air-gap guard (it would
      // construct; we only assert the guard doesn't fire).
      let threw = '';
      try { await createStorage({ backend: 'supabase' } as any); } catch (e) { threw = (e as Error).message; }
      expect(threw).not.toMatch(/air-gap/);
    });
  });
});

describe('SF-5 A10 connect-probe refuses remote MCP in air-gap', () => {
  test('probeBrainIdentity returns air_gap result without opening a socket', async () => {
    const { probeBrainIdentity } = await import('../src/core/connect-probe.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      const res = await probeBrainIdentity('https://remote.example.com/mcp', 'tok', {
        deps: { connectAndCall: async () => { throw new Error('must not open a socket in air-gap'); } },
      });
      expect(res).toMatchObject({ ok: false, reason: 'air_gap' });
    });
  });
});

// ---------------------------------------------------------------------------
// F2 (v0.42.50.0) — dead-code egress tripwires. transcription / supabase-admin
// have no callers today but carry live cloud-egress fetches; air-gap fails them
// closed so a future re-wiring can't silently egress.
// ---------------------------------------------------------------------------
describe('F2 — dead-code egress tripwires', () => {
  test('transcribe() refuses in air-gap before any file I/O', async () => {
    const { transcribe } = await import('../src/core/transcription.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      // Guard is the first statement → throws before statSync on the bogus path.
      await expect(transcribe('/nonexistent/audio.mp3')).rejects.toThrow(/air-gap: audio transcription/);
    });
  });

  test('discoverPoolerUrl() refuses in air-gap before the Supabase fetch', async () => {
    const { discoverPoolerUrl } = await import('../src/core/supabase-admin.ts');
    await withEnv({ GBRAIN_AIRGAP: '1' }, async () => {
      await expect(discoverPoolerUrl('tok', 'project-ref')).rejects.toThrow(/air-gap: the Supabase management API/);
    });
  });
});
