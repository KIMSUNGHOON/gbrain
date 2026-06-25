#!/usr/bin/env bash
# v0.42.48.0 (PR-7 / W7.4) CI guard: verifier/Generator scope co-grant ban.
#
# The verifier substrate's anti-spoof floor (doc 28 §3 / §10) requires that the
# `verifier` capability is NEVER held by the same principal that can perform a
# Generator/write action. A token granted BOTH `verifier` (deposit a PASS
# receipt) AND a write-class scope (`write` | `shared_write` | `admin`) could
# vouch for its own world/supersede write — defeating Gate 1 + Gate 2.
#
# Two layers:
#   1. STRUCTURAL (src/core/scope.ts IMPLIES table): admin must NOT imply
#      `verifier`, and `verifier` must imply ONLY itself. If either drifts, a
#      broad/admin token would silently satisfy a `verifier`-scoped op.
#   2. LITERAL (scope-grant array literals across src/ + admin/src/): no single
#      array literal grants `verifier` alongside a write-class scope. A
#      legitimate exception carries `// gbrain-allow-cogrant: <reason>` on the
#      SAME LINE (there is no current legitimate case; the escape exists so a
#      future deliberate one is reviewed, not silently blocked).
#
# Usage: scripts/check-verifier-cogrant.sh
# Exit:  0 clean, 1 on violation, 2 on internal error (file/parse).

set -euo pipefail

# Scan-root resolution mirrors check-system-of-record.sh so the self-test can
# point GBRAIN_SCAN_ROOT at a temp fixture dir.
if [ -n "${GBRAIN_SCAN_ROOT:-}" ]; then
  ROOT="$GBRAIN_SCAN_ROOT"
else
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
cd "$ROOT"

SCOPE_FILE="src/core/scope.ts"
[ -f "$SCOPE_FILE" ] || { echo "[check-verifier-cogrant] missing $SCOPE_FILE" >&2; exit 2; }

GEN_SCOPES=(admin write shared_write)
fail=0

# Quote class: scope members may be written with single OR double quotes. The
# guard MUST catch both — a double-quoted `admin: new Set(["verifier"])` is the
# exact anti-spoof drift this exists to block. `Q` matches either quote char.
Q="['\"]"

# ── Layer 1: structural IMPLIES invariants (quote- + multi-line-resilient) ───
# Flatten the whole IMPLIES object onto one logical line so a member set written
# across multiple lines is matched identically to a single-line one. Without the
# flatten, an anchor on `<scope>: new Set([` would miss members on later lines.
IMPLIES_FLAT=$(awk '/const IMPLIES/{c=1} c{printf "%s ", $0} c && /};/{exit}' "$SCOPE_FILE")
if [ -z "$IMPLIES_FLAT" ]; then
  echo "[check-verifier-cogrant] could not find the IMPLIES table in $SCOPE_FILE" >&2
  exit 2
fi

# `verifier: new Set([...])` members must be exactly {verifier}. `[^]]*` scopes
# to verifier's own bracket (stops at its closing `]`), even on the flat line.
verifier_set=$(printf '%s' "$IMPLIES_FLAT" | grep -oE "verifier:[[:space:]]*new Set\(\[[^]]*\]" || true)
if [ -z "$verifier_set" ]; then
  echo "[check-verifier-cogrant] could not find IMPLIES.verifier in $SCOPE_FILE" >&2
  exit 2
fi
verifier_members=$(printf '%s' "$verifier_set" | grep -oE "${Q}[a-z_]+${Q}" | tr -d "'\"" | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')
if [ "$verifier_members" != "verifier" ]; then
  echo "ERROR: IMPLIES.verifier must imply ONLY itself, got: {$verifier_members}" >&2
  echo "       A verifier scope that implies a write-class capability lets a deposit" >&2
  echo "       token also write — defeating the Gate-1/Gate-2 separation." >&2
  fail=1
fi

# No write-class scope's IMPLIES Set may contain `verifier`. `(^|[^a-z_])`
# before the key stops `write` from matching inside `shared_write:`.
for gen in "${GEN_SCOPES[@]}"; do
  gen_set=$(printf '%s' "$IMPLIES_FLAT" | grep -oE "(^|[^a-z_])$gen:[[:space:]]*new Set\(\[[^]]*\]" || true)
  if [ -n "$gen_set" ] && printf '%s' "$gen_set" | grep -qE "${Q}verifier${Q}"; then
    echo "ERROR: IMPLIES.$gen must NOT imply 'verifier' (a $gen token could deposit receipts)." >&2
    echo "       Offending set: $gen_set" >&2
    fail=1
  fi
done

# ── Layer 2: literal co-grant array bans (quote- + multi-line-resilient) ─────
# A scope-grant array literal `[... verifier ... write ...]` (either order, ' or
# " quotes, spanning lines). Each file is flattened (newlines → spaces) so a
# multi-element array written one-per-line is matched; `[^][]*` still requires
# both members in the SAME `[...]` (a `]` from another array breaks the match),
# so unrelated arrays don't false-positive. Canonical scope.ts is SAFE: the
# `Scope` type is a pipe-union (no `[`), and the ALLOWED_SCOPES* / pipe lists put
# each scope in its own bracket-free context. A deliberate exception carries a
# `// gbrain-allow-cogrant:` marker anywhere in the file.
SCOPE_DIRS=(src admin/src)
gen_alt='write|shared_write|admin'
re="\[[^][]*${Q}verifier${Q}[^][]*${Q}($gen_alt)${Q}|\[[^][]*${Q}($gen_alt)${Q}[^][]*${Q}verifier${Q}"
cogrant=""
for dir in "${SCOPE_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # Skip the canonical scope-DEFINITION files: their ALLOWED_SCOPES /
    # ALLOWED_SCOPES_LIST / DEFAULT_LOCAL_PIPE_SCOPES arrays comprehensively list
    # EVERY scope (verifier + write together) by design — those are definitions,
    # not token grants. scope.ts's grant semantics (the IMPLIES table) are owned
    # by Layer 1 above; scope-constants.ts is its CI-drift-checked mirror.
    case "$f" in
      */core/scope.ts|*/lib/scope-constants.ts) continue ;;
    esac
    flat=$(tr '\n' ' ' < "$f")
    if printf '%s' "$flat" | grep -qE "$re" \
       && ! printf '%s' "$flat" | grep -qE 'gbrain-allow-cogrant:'; then
      cogrant="${cogrant}${f}"$'\n'
    fi
  done < <(grep -rElE --include='*.ts' --include='*.tsx' "${Q}verifier${Q}" "$dir" 2>/dev/null || true)
done
if [ -n "$cogrant" ]; then
  echo "ERROR: scope-grant literal co-grants 'verifier' with a write-class scope in:" >&2
  printf '%s' "$cogrant" >&2
  echo "       A principal must never hold both. If deliberate, add" >&2
  echo "       \`// gbrain-allow-cogrant: <reason>\` in the file." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "[check-verifier-cogrant] ok: verifier scope is isolated from write-class grants"
