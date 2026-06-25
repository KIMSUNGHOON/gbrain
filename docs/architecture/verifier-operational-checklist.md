# Verifier substrate — operational deploy checklist (W7.4)

The verifier promotion gate (Gate 1 in `src/mcp/dispatch.ts`, Gate 2 in
`src/core/facts/backstop.ts`) is enforced in code. Its anti-spoof floor,
however, rests on a small set of **operational** preconditions that code
*cannot* enforce — the trust boundary is the OS process and the database role,
not a scope check. Stage-7 (PR-7) pins everything code-enforceable with tests +
CI guards; this checklist is the residue that the operator must guarantee at
deploy time. **Treat every item as HARD: the in-process gate is sound only if
these hold.**

These items are inert on a default single-user install (no Generator/Verifier
principals exist). They matter once a separate verifier (`cd_score`-class)
deposits receipts that authorize shared/world writes.

## 1. Generator and Verifier are remote OAuth principals only

The trusted-local bypass (`ctx.remote === false`) skips scope enforcement by
design — it is the machine operator's own CLI. Therefore a Generator (the agent
that *produces* a candidate write) and the Verifier (the process that *deposits*
a PASS receipt) must NEVER reach the brain over a trusted-local transport:

- **No stdio MCP pipe.** The local `gbrain serve` stdio pipe inherits
  `DEFAULT_LOCAL_PIPE_SCOPES` (`read`/`write`/`admin`, but never `verifier`/
  `shared_write`). It is owned by the operator. A Generator/Verifier on stdio
  would run with that broad default.
- **No `remote === false` (CLI / in-process).** Same reason — the gate does not
  fire for trusted-local callers. (The test `test/dispatch-scope-gate.test.ts`
  pins WHY: a `remote:false` verifier-scoped call is intentionally ungated.)
- **No legacy bearer token.** Legacy grandfather tokens were disabled in PR-0
  (migration v117 blanket-revoke); a re-introduced one must never be issued to a
  Generator/Verifier. This is additionally code-enforced and regression-pinned.

Enforcement = deployment topology: run the Generator/Verifier as remote OAuth
clients that physically cannot open the local pipe or invoke the CLI binary.

## 2. Database-credential isolation

gbrain holds whatever DB credentials it is handed and cannot assert about its
own role. Isolate at the database layer:

- The Generator's DB role must NOT be able to write `verifier_receipts`
  (the deposit path) nor the protected `shared:<domain>` source rows.
- The Verifier's DB role deposits receipts but must NOT perform the
  fact/page write it is vouching for.

Enforce with per-role Postgres `GRANT`/`REVOKE` and a distinct `DATABASE_URL`
per principal. (In-process substitutes that DO hold: the transport-agnostic
scope gate + honor-time replay binding — see
`test/dispatch-scope-gate.test.ts`, `test/verifier-honor.test.ts` — but they are
a backstop, not a replacement for credential isolation.)

## 3. No verifier/Generator scope co-grant

A single token must never hold `verifier` (deposit a PASS) AND a write-class
scope (`write` | `shared_write` | `admin`) — it could vouch for its own write.

This one IS partially code-guarded: `scripts/check-verifier-cogrant.sh`
(wired into `bun run check:all`) fails CI if the `scope.ts` `IMPLIES` table ever
lets a write-class scope imply `verifier`, or if any scope-grant array literal
co-grants the two. The operator must still ensure no *runtime* OAuth client
registration co-grants them (a deliberate exception carries an
`// gbrain-allow-cogrant:` review marker).

---

**Acceptance proof (deploy-time, not code).** Stage-7's W7.3 suite proves the
in-process gate denies every unauthorized shared/world write with zero rows
written. The operational floor above is what makes that gate meaningful in a
multi-principal deployment; verify it as part of the air-gap / on-prem
acceptance pass (see `docs/27` A-ACC).
