/**
 * SSRF defense helpers — extracted from src/commands/integrations.ts (v0.28).
 *
 * Lives in src/core/ so anything in src/core/ (e.g. git-remote.ts) can call
 * the gate without inverting the layering boundary. integrations.ts re-exports
 * for backward compat with existing imports + tests.
 *
 * The helpers are responsible for catching the bypass forms commonly used
 * to defeat naive private-IP filters: IPv4-mapped IPv6, hex/octal/single-int
 * encodings, IPv6 loopback, metadata hostnames, scheme allowlist, and CGNAT
 * 100.64/10 (which is what hits when reaching a Tailscale host).
 */

/** Parse an IPv4 octet from decimal, hex (0x prefix), or octal (leading 0) notation. */
export function parseOctet(s: string): number {
  if (s.length === 0) return NaN;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(s)) return NaN;
    return parseInt(s, 16);
  }
  if (s.length > 1 && s.startsWith('0')) {
    if (!/^0[0-7]+$/.test(s)) return NaN;
    return parseInt(s, 8);
  }
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

/**
 * Convert an IPv4 hostname to 4 octets. Handles bypass encodings:
 *   - Dotted decimal: 127.0.0.1
 *   - Single decimal: 2130706433 (= 0x7f000001)
 *   - Hex: 0x7f000001
 *   - Per-octet hex/octal: 0x7f.0.0.1, 0177.0.0.1
 * Returns null for non-IP hostnames (fall through to hostname-based checks).
 */
export function hostnameToOctets(hostname: string): number[] | null {
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const octets = parts.map(parseOctet);
    if (octets.every(o => Number.isFinite(o) && o >= 0 && o <= 255)) return octets;
  }
  return null;
}

/** Classify an IPv4 address as internal/private/reserved. */
export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;              // 127.0.0.0/8 loopback
  if (a === 10) return true;               // 10.0.0.0/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. AWS metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale)
  if (a === 0) return true;                // 0.0.0.0/8 unspecified
  return false;
}

/** Returns true if the URL targets an internal/metadata endpoint or uses a non-http(s) scheme. Fail-closed on parse errors. */
export function isInternalUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true; // malformed → block
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  let host = url.hostname.toLowerCase();

  const metadataHostnames = new Set([
    'metadata.google.internal',
    'metadata.google',
    'metadata',
    'instance-data',
    'instance-data.ec2.internal',
  ]);
  if (metadataHostnames.has(host)) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === '::1' || host === '::') return true;

  // v0.28.1 codex finding (HIGH): also block IPv6 ULA fc00::/7 (private
  // unique-local addresses) and link-local fe80::/10. Without this, an
  // attacker who controls a hostname's AAAA record can target internal
  // IPv6 services even though IPv4 internal-classification fires.
  // ULA: first hex tuple matches /^fc[0-9a-f]{2}/ or /^fd[0-9a-f]{2}/
  // Link-local: first hex tuple matches /^fe[89ab][0-9a-f]/
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) {
    return true;
  }

  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7);
    const dotted = hostnameToOctets(tail);
    if (dotted && isPrivateIpv4(dotted)) return true;
    const hextets = tail.split(':');
    if (hextets.length === 2 && hextets.every(h => /^[0-9a-f]{1,4}$/.test(h))) {
      const hi = parseInt(hextets[0], 16);
      const lo = parseInt(hextets[1], 16);
      const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      if (isPrivateIpv4(octets)) return true;
    }
  }

  const octets = hostnameToOctets(host);
  if (octets && isPrivateIpv4(octets)) return true;

  if (host.endsWith('.')) {
    const stripped = host.slice(0, -1);
    const strippedOctets = hostnameToOctets(stripped);
    if (strippedOctets && isPrivateIpv4(strippedOctets)) return true;
  }

  return false;
}

// ── A9 (v0.42.47.0, PR-6): default-deny egress ALLOWLIST for air-gap mode ─────
//
// Today's SSRF defense (`isInternalUrl` above, `ssrf-validate.ts`) is a
// DENY-LIST: it blocks internal/metadata/private targets and lets everything
// else out. That is correct for a cloud install. An air-gapped deploy needs the
// inverse at the fetch boundary: an ALLOWLIST where only explicitly-permitted
// on-prem hosts may egress, and everything else — including the public internet
// — is denied. These helpers add that gate WITHOUT changing cloud behavior:
// `isAllowedEgressHost` is a pure pass-through (returns true) whenever air-gap
// is off, so the deny-list semantics above are fully preserved for default
// installs. The gate is wired at the central SSRF chokepoint
// (`ssrf-validate.ts:validateAndResolveUrl`, covering image-loader +
// `fetchWithSSRFGuard`), the url-reachable resolver, and the integrations HTTP
// check. Git egress has its own allowlist (A21, `git-remote.ts`); inference
// egress is governed by the LiteLLM base-URL pin + the D-MEM firewall, NOT this
// app-layer gate.

import { isAirGap } from './airgap.ts';
import { loadConfig, type GBrainConfig } from './config.ts';

/** Split a comma/whitespace-separated allowlist string into normalized host entries. */
export function parseHostAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Match a hostname against a single allowlist entry. Supports:
 *   - exact:           'gitlab.corp.internal'  ⇒ only that host
 *   - dot-suffix:      '.corp.internal'        ⇒ corp.internal AND any *.corp.internal
 *   - star-suffix:     '*.corp.internal'       ⇒ same as '.corp.internal'
 * Trailing dots and case are normalized on both sides.
 */
export function hostMatchesAllowEntry(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  let e = entry.toLowerCase().replace(/\.$/, '');
  if (!e) return false;
  if (e.startsWith('*.')) e = e.slice(1); // '*.x' → '.x'
  if (e.startsWith('.')) {
    const apex = e.slice(1); // '.x' → 'x'
    return h === apex || h.endsWith(e);
  }
  return h === e;
}

/** True iff `host` matches any entry in `allowlist`. Empty allowlist ⇒ false (deny). */
export function hostInAllowlist(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some(e => hostMatchesAllowEntry(host, e));
}

/** Egress allowlist (A9): env `GBRAIN_EGRESS_ALLOWLIST` ∪ `config.airgap.egress_allowlist`. */
export function getEgressAllowlist(config?: GBrainConfig | null): string[] {
  const cfg = config !== undefined ? config : loadConfig();
  const fromEnv = parseHostAllowlist(process.env.GBRAIN_EGRESS_ALLOWLIST);
  const fromCfg = (cfg?.airgap?.egress_allowlist ?? []).map(s => s.toLowerCase());
  return [...fromEnv, ...fromCfg];
}

/**
 * A9 — egress allowlist gate. Returns true (ALLOW) for every URL when NOT in
 * air-gap, so cloud installs keep today's deny-list behavior unchanged. In
 * air-gap, only allowlisted hosts pass; an EMPTY allowlist denies ALL egress.
 * Fail-closed on malformed URLs / non-http(s) schemes. `config` is optional
 * (threaded through where available to avoid a redundant config read).
 */
export function isAllowedEgressHost(urlStr: string, config?: GBrainConfig | null): boolean {
  if (!isAirGap(config)) return true; // cloud: no-op pass-through (deny-list still applies elsewhere)
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return false; // malformed → deny
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return hostInAllowlist(host, getEgressAllowlist(config));
}
