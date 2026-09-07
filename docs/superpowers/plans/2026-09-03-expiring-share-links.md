# Expiring Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner (someone who typed the passcode) mint a link that grants
read-only access to the shortlist for 24 hours, 7 days, or 30 days — with no database,
no per-link state, and no way for a link holder to mint further links.

**Architecture:** The session cookie's signed payload grows from the literal
`"authenticated"` to a versioned claim set — `v1-<role>-<expiresAt>-<keyVersion>` —
signed with the existing HMAC-SHA256 `COOKIE_SECRET`. A share link is nothing more than
a `guest`-role claim set in a URL (`/s/<token>`); a new route handler verifies it and
sets it as the cookie with `maxAge` equal to the token's *remaining* life, then
redirects to `/`. Owners get the same encoding with `role=owner` and a 90-day expiry.
`proxy.ts` accepts either role. All branching logic lives in `lib/` as pure functions
with unit tests; the route handler, server action, and components are thin wrappers.

**Tech Stack:** unchanged — Next.js 16.3.3 App Router with `cacheComponents: true`,
React 19, `node:crypto` HMAC, vitest. No new dependencies.

**Spec:** none as a separate file. The agreed design is captured in the "Design
decisions" section below; this plan argues from it. If a future spec is written it
should live at `docs/superpowers/specs/2026-09-03-expiring-share-links-design.md`.

**Branch:** per the repo's trunk-based convention, execute on
`git fetch origin && git checkout -b bgiese/expiring-share-links origin/main`.

## Global Constraints

- **Stateless. No database writes, ever.** The app's Turso token is deliberately
  read-only (`.env.example`, `docs/DEPLOYMENT.md` §5). Expiry and role are *inside* the
  signed payload; there is no issued-links table and this plan must not add one.
- **Next.js 16 conventions only.** `proxy.ts` (not `middleware.ts`) — verified in
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`:
  "The `middleware` file convention is deprecated and has been renamed to `proxy`",
  and "Proxy defaults to using the Node.js runtime", so `node:crypto` in `lib/auth.ts`
  remains usable from the proxy. Route handler `params` is a `Promise`
  (`route.md` §"Dynamic Route Segments"). `cookies()` and `headers()` are async and,
  with Cache Components enabled, **must be called inside a `<Suspense>` boundary** in
  a page or the build fails (`cookies.md` §"Good to know").
- **No `use cache` anywhere in this feature.** Every new server-side piece reads request
  data (`cookies()`, `headers()`, `params`) or the clock (`nowSeconds()`), all of which
  are forbidden or frozen-at-build inside a cached scope. `OwnerTools` streams in behind
  its own `<Suspense>` as a dynamic component; do not "optimise" it with `use cache`.
- **TDD.** Every task writes its tests first, runs them red, then implements. Tests
  live beside their module as `lib/*.test.ts`. `npm test` = `vitest run`;
  `npm run lint` = `eslint`; `npx tsc --noEmit` type-checks.
- **Pure logic in `lib/`, thin adapters in `app/`.** Matches the repo's
  "unit-test data-layer branching, don't e2e the pages" philosophy. Nothing in `app/`
  gets a unit test; everything it calls in `lib/` does.
- **Timing-safe signature comparison is preserved** (`timingSafeEqual` with an explicit
  length check first) and pinned by a test.
- **The HMAC is computed over the raw payload string exactly as received**, never over
  re-serialized parsed fields, so no canonicalization gap (e.g. `0100` vs `100`) can be
  exploited.
- Conventional Commits, subject under 50 characters, one commit per task.

---

## Design decisions (the agreed design, plus the calls this plan makes)

### 1. Payload encoding

```
<format>-<role>-<expiresAt>-<keyVersion>.<hex hmac-sha256>
v1-guest-1760486400-1.9c3f…e2
```

| Field        | Allowed values                        | Why this charset                             |
|--------------|---------------------------------------|----------------------------------------------|
| `format`     | literal `v1`                          | lets a future `v2` coexist during rollout    |
| `role`       | `owner` \| `guest`                    | closed enum, checked at sign *and* verify    |
| `expiresAt`  | `/^\d{1,12}$/`, unix **seconds**      | integer; no `.` possible                     |
| `keyVersion` | `/^[A-Za-z0-9]{1,32}$/`               | excludes `-` and `.` by construction         |
| signature    | `/^[0-9a-f]{64}$/`                    | hex HMAC output                              |

Field separator `-`, signature separator `.` (the existing one). **Injection is
structurally impossible**: none of the four fields' allowed characters include `-` or
`.`, `signSession` throws if a field violates its regex, and `verifySession` requires
*exactly* two `.`-parts and *exactly* four `-`-parts before it does anything else.
Both halves are tested. `-` and `.` are unreserved in URLs (RFC 3986) and legal in
cookie values (RFC 6265), so one string serves as both the URL token and the cookie
value with no encoding step. Colons and base64 padding were rejected for exactly that
reason.

### 2. `verifySession` replaces `isValidSession`

`isValidSession(value): boolean` becomes `verifySession(value, nowSeconds?): SessionClaims | null`.
A boolean-named function returning an object would mislead; renaming forces every call
site (there are two: `proxy.ts` and `lib/auth.test.ts`) to be revisited, which is what
we want. It checks, in order: shape → format → role → key version equals the current
env value → signature (timing-safe) → not expired. Any failure returns `null`.

### 3. Roles and cookie lifetime

- Correct passcode at `/enter` → `signSession({ role: 'owner', expiresAt: now + 90d })`,
  cookie `maxAge` 90 days (unchanged UX).
- `/s/<token>` with a valid **guest** token → cookie value is the token verbatim,
  `maxAge = expiresAt - now` (floored, minimum 1). A copied cookie therefore dies with
  the link.
- An **owner**-role value presented as a share link is rejected. Owner sessions must
  never be usable as URLs, so a leaked owner cookie cannot be turned into a
  privilege-granting link.
- If the visitor already holds a valid **owner** cookie, the share route leaves it
  alone (an owner clicking their own link must not downgrade themselves).
- Guests can forward the link they were given; that is inherent to any bearer link and
  is bounded by its expiry. What they cannot do is mint a link with a *new* expiry —
  `buildShareLink` requires `role === 'owner'` server-side regardless of what the UI
  shows.

### 4. Share route and failure landing

`app/s/[token]/route.ts` (GET). Success → `303` redirect to `/` with the cookie set and
`Cache-Control: no-store`. Failure (missing, malformed, tampered, expired, wrong key
version, owner-role) → `303` redirect to `/enter?error=link`, and the enter page shows
"That share link is invalid or has expired — ask for a new one." above the passcode
form. Landing on `/enter` is deliberate: it is the only page a stranger can see, it
already exists, and it still offers the passcode path for the two owners. The
`proxy.ts` matcher gains `s(?:/|$)` to the exclusion list — without it the proxy
redirects `/s/…` to `/enter` before the handler runs.

### 5. Link generation and the absolute origin

A server action `createShareLink(prev, formData)` (for `useActionState`) reads the
cookie, delegates to `buildShareLink()` in `lib/share.ts`, and returns
`{ ok: true, url, expiresAt } | { ok: false, message }`. The origin comes from request
headers via `shareOrigin(headers)`: `x-forwarded-proto` + `x-forwarded-host`, falling
back to `host`, falling back to `http` for `localhost`/`127.0.0.1` and `https`
otherwise. Vercel sets both forwarded headers on every deployment (production,
preview, and custom domains alike), and Next's own server-action CSRF check already
rejects requests whose `Origin` disagrees with `Host`/`X-Forwarded-Host`
(`server-actions.md` §"Security"), so the header value is one the owner's browser
attested to. `VERCEL_PROJECT_PRODUCTION_URL` was rejected: it is wrong on preview
deployments and in `next dev`. A hard-coded `SHARE_BASE_URL` env var was rejected for
the same reason plus one more secret to keep in sync.

Durations are a closed allowlist — `'24h' | '7d' | '30d'` — validated server-side.
The action never accepts raw seconds, so 30 days is the hard ceiling on any link.

### 6. Revocation: `SHARE_KEY_VERSION`

No per-link revocation (out of scope). `SHARE_KEY_VERSION` (default `1` when unset, so
deploying this change requires no env change) is embedded in every signed payload and
compared on verify. Bumping it invalidates **every outstanding link at once** — and,
because owner sessions carry it too, **logs both owners out**, who re-enter the
passcode once. That side effect is accepted on purpose: a single mechanism that is
impossible to half-apply beats two mechanisms that can drift, and re-typing a passcode
is a two-person cost. It is strictly lighter than the existing revocation path
(rotating `COOKIE_SECRET`), which this plan leaves in place for "the secret itself
leaked".

### 7. Secret: reuse `COOKIE_SECRET`

The share token *is* a session credential — the URL string becomes the cookie verbatim
and `proxy.ts` verifies it on every request. A separate `SHARE_SECRET` would therefore
have to be accepted by the proxy too, or the share route would have to re-mint a
`COOKIE_SECRET`-signed cookie, at which point the second secret protects nothing: a
leaked `COOKIE_SECRET` already forges *owner* sessions, which are strictly more
powerful than any guest link. The only real benefit of a second secret — rotating
share links without logging owners out — is already delivered by `SHARE_KEY_VERSION`
(with the owner-logout caveat above, accepted). **Tradeoff stated plainly:** one secret
means one blast radius; we accept that because the two blast radii would be nested
anyway.

### 8. Migration: every existing cookie dies at deploy

The old value `authenticated.<sig>` has one `-`-part, not four, so `verifySession`
returns `null` and the proxy bounces the holder to `/enter`. That is Ben and Megan,
once each, per device. **No dual-format grace period is built** — it would add code
paths to a security module for a one-time cost of two passcode entries. This is pinned
by a test ("legacy format is rejected") so nobody accidentally re-adds it. Deploy
order: none required — `SHARE_KEY_VERSION` defaults, `COOKIE_SECRET` is unchanged.

### Out of scope (deliberately)

Per-link revocation, a "you are a guest, expires in N days" banner, link-usage counts,
rate limiting on `/s/`, and a share control on the detail page. Each is a follow-on,
and none changes the token format.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `lib/auth.ts` | claim encoding, signing, timing-safe verification, expiry math | 1 |
| `lib/auth.test.ts` | every security case for the token format | 1 |
| `proxy.ts` | accept any valid role; exclude `/s/` from the gate | 2, 4 |
| `app/enter/actions.ts` | mint an `owner` claim set on correct passcode | 2 |
| `lib/share.ts` | duration allowlist, origin derivation, link building, visit resolution | 3 |
| `lib/share.test.ts` | owner-only gating, remaining-life maxAge, rejection cases | 3 |
| `app/s/[token]/route.ts` | thin GET handler around `resolveShareVisit` | 4 |
| `app/enter/page.tsx` | `error=link` message | 4 |
| `app/actions.ts` | `createShareLink` server action (thin, owner-gated via `lib/share`) | 5 |
| `app/OwnerTools.tsx` | async server component: reads cookie, renders `ShareControl` for owners only | 5 |
| `app/ShareControl.tsx` | client component: duration picker, create, copy | 5 |
| `app/page.tsx` | mounts `OwnerTools` inside its own `<Suspense>` | 5 |
| `app/globals.css` | a few lines for the share control | 5 |
| `.env.example`, `README.md`, `docs/DEPLOYMENT.md` | document `SHARE_KEY_VERSION` and the revocation model | 6 |

---

## Task 1 — `lib/auth.ts`: versioned claims, `verifySession`, expiry

**Files:**
- Modify: `lib/auth.ts`
- Modify: `lib/auth.test.ts` (rewrite the `session signing` describe; keep `safeNext` tests verbatim)

**Interfaces:**
- Consumes: nothing new. `COOKIE_SECRET` and (new) `SHARE_KEY_VERSION` from `process.env`.
- Produces (every later task relies on these exact names):

```ts
export const SESSION_COOKIE = 'short_list_session'          // unchanged
export const OWNER_SESSION_SECONDS = 60 * 60 * 24 * 90       // moved here from enter/actions.ts
export type Role = 'owner' | 'guest'
export type SessionClaims = { role: Role; expiresAt: number; keyVersion: string }  // expiresAt: unix seconds
export function nowSeconds(): number                         // Math.floor(Date.now() / 1000)
export function currentKeyVersion(): string                  // process.env.SHARE_KEY_VERSION ?? '1'; throws if it fails KEY_VERSION_RE
export function signSession(claims: { role: Role; expiresAt: number }): string  // throws on invalid field
export function verifySession(value: string | undefined, now?: number): SessionClaims | null
export function remainingSeconds(claims: SessionClaims, now?: number): number   // max(0, expiresAt - now)
export function safeNext(next: string | null | undefined): string               // unchanged
```

`isValidSession` and the `PAYLOAD` constant are **deleted**. `signSession()` with no
argument no longer exists — TypeScript will flag the two call sites, which Task 2 fixes.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('session signing', …)` block in `lib/auth.test.ts` with the
following. Leave the `describe('safeNext', …)` block exactly as it is.

```ts
// lib/auth.test.ts (top of file — vi.mock is hoisted above the imports)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { timingSafeEqual, createHmac } from 'node:crypto'
import {
  signSession,
  verifySession,
  remainingSeconds,
  currentKeyVersion,
  OWNER_SESSION_SECONDS,
  safeNext,
} from './auth'

// Wrap (not replace) timingSafeEqual so a test can assert the comparison
// actually goes through it. Everything else in node:crypto is untouched.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const NOW = 1_760_000_000 // fixed "current time" in unix seconds

describe('session claims', () => {
  const originalSecret = process.env.COOKIE_SECRET
  const originalKeyVersion = process.env.SHARE_KEY_VERSION

  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
    process.env.SHARE_KEY_VERSION = '1'
    vi.mocked(timingSafeEqual).mockClear()
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
    process.env.SHARE_KEY_VERSION = originalKeyVersion
  })

  it('an owner token round-trips its claims', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + OWNER_SESSION_SECONDS })
    expect(verifySession(token, NOW)).toEqual({
      role: 'owner',
      expiresAt: NOW + OWNER_SESSION_SECONDS,
      keyVersion: '1',
    })
  })

  it('a guest token round-trips its claims', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 3600 })
    expect(verifySession(token, NOW)).toEqual({ role: 'guest', expiresAt: NOW + 3600, keyVersion: '1' })
  })

  it('the wire format is v1-<role>-<exp>-<kv>.<64 hex chars>', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(token).toMatch(/^v1-guest-1760000060-1\.[0-9a-f]{64}$/)
  })

  it('undefined and empty values are invalid', () => {
    expect(verifySession(undefined, NOW)).toBeNull()
    expect(verifySession('', NOW)).toBeNull()
  })

  it('the pre-v1 "authenticated.<sig>" cookie is rejected (deploy logs everyone out once)', () => {
    const sig = createHmac('sha256', 'test-secret').update('authenticated').digest('hex')
    expect(verifySession(`authenticated.${sig}`, NOW)).toBeNull()
  })

  // --- expiry -------------------------------------------------------------

  it('is valid one second before expiry and invalid at expiry', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token, NOW + 59)).not.toBeNull()
    expect(verifySession(token, NOW + 60)).toBeNull()
    expect(verifySession(token, NOW + 61)).toBeNull()
  })

  it('remainingSeconds counts down to zero and never goes negative', () => {
    const claims = verifySession(signSession({ role: 'guest', expiresAt: NOW + 60 }), NOW)!
    expect(remainingSeconds(claims, NOW)).toBe(60)
    expect(remainingSeconds(claims, NOW + 45)).toBe(15)
    expect(remainingSeconds(claims, NOW + 999)).toBe(0)
  })

  it('signSession rejects a non-integer or past-looking expiry', () => {
    expect(() => signSession({ role: 'guest', expiresAt: 1.5 })).toThrow()
    expect(() => signSession({ role: 'guest', expiresAt: -1 })).toThrow()
    expect(() => signSession({ role: 'guest', expiresAt: NaN })).toThrow()
  })

  // --- tampering ----------------------------------------------------------

  it('a tampered signature is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    const last = token.slice(-1)
    const flipped = token.slice(0, -1) + (last === '0' ? '1' : '0')
    expect(verifySession(flipped, NOW)).toBeNull()
    expect(verifySession(token + 'x', NOW)).toBeNull()
  })

  it('a tampered expiry (extended, signature kept) is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    const [payload, sig] = token.split('.')
    const [v, role, , kv] = payload.split('-')
    expect(verifySession(`${v}-${role}-${NOW + 999_999}-${kv}.${sig}`, NOW)).toBeNull()
  })

  it('a tampered role (guest promoted to owner, signature kept) is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token.replace('-guest-', '-owner-'), NOW)).toBeNull()
  })

  it('a token signed under a different secret is invalid', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + 60 })
    process.env.COOKIE_SECRET = 'a-different-secret'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('a signature of the wrong length is rejected without throwing', () => {
    expect(verifySession(`v1-guest-${NOW + 60}-1.abc`, NOW)).toBeNull()
  })

  // --- key version --------------------------------------------------------

  it('a token minted under key version 1 is invalid once the version is bumped to 2', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    process.env.SHARE_KEY_VERSION = '2'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('an owner token is also invalidated by a key-version bump (accepted side effect)', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + 60 })
    process.env.SHARE_KEY_VERSION = '2'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('key version defaults to "1" when the env var is unset', () => {
    delete process.env.SHARE_KEY_VERSION
    expect(currentKeyVersion()).toBe('1')
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token, NOW)?.keyVersion).toBe('1')
  })

  // --- field injection ----------------------------------------------------

  it('signSession refuses a key version containing a separator or other junk', () => {
    for (const bad of ['1-owner', '1.x', '', 'a b', 'x'.repeat(33)]) {
      process.env.SHARE_KEY_VERSION = bad
      expect(() => signSession({ role: 'guest', expiresAt: NOW + 60 }), bad).toThrow()
    }
  })

  it('verifySession refuses a key version containing a separator even if the env matches', () => {
    // Env is corrupted the same way, so a naive "kv === env" check would pass.
    process.env.SHARE_KEY_VERSION = '1-owner'
    const payload = `v1-guest-${NOW + 60}-1-owner`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('an unknown role is refused at sign and verify time', () => {
    // @ts-expect-error -- deliberately wrong role
    expect(() => signSession({ role: 'admin', expiresAt: NOW + 60 })).toThrow()
    const payload = `v1-admin-${NOW + 60}-1`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('an unknown format version is refused', () => {
    const payload = `v2-guest-${NOW + 60}-1`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('extra fields or extra dots are refused even when correctly signed', () => {
    for (const payload of [
      `v1-guest-${NOW + 60}-1-extra`,
      `v1-guest-${NOW + 60}`,
      `v1-guest-${NOW + 60}-1.extra`,
    ]) {
      const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
      expect(verifySession(`${payload}.${sig}`, NOW), payload).toBeNull()
    }
  })

  it('a non-numeric or padded expiry is refused', () => {
    for (const exp of ['abc', '1e9', '', '0'.repeat(13), ' 100']) {
      const payload = `v1-guest-${exp}-1`
      const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
      expect(verifySession(`${payload}.${sig}`, NOW), exp).toBeNull()
    }
  })

  // --- timing safety ------------------------------------------------------

  it('compares signatures with timingSafeEqual', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    verifySession(token, NOW)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it('does not reach timingSafeEqual when the shape is already wrong (no oracle on junk)', () => {
    verifySession('garbage', NOW)
    verifySession(`v1-guest-${NOW + 60}-1.abc`, NOW) // wrong length
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/auth.test.ts`
Expected: FAIL — `verifySession`, `remainingSeconds`, `currentKeyVersion`,
`OWNER_SESSION_SECONDS` are not exported; `signSession` ignores its argument.

- [ ] **Step 3: Rewrite `lib/auth.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'short_list_session'
export const OWNER_SESSION_SECONDS = 60 * 60 * 24 * 90

export type Role = 'owner' | 'guest'
export type SessionClaims = { role: Role; expiresAt: number; keyVersion: string }

// Wire format: `v1-<role>-<expiresAt>-<keyVersion>.<hex hmac>`.
// The four fields' charsets exclude both separators, so a field can never
// smuggle a separator in, and parsing requires exact part counts before
// anything else is looked at. Keep the regexes and the separators in sync.
const FORMAT = 'v1'
const FIELD_SEP = '-'
const SIG_SEP = '.'
const ROLES: ReadonlySet<string> = new Set<Role>(['owner', 'guest'])
const EXP_RE = /^\d{1,12}$/
const KEY_VERSION_RE = /^[A-Za-z0-9]{1,32}$/
const SIG_RE = /^[0-9a-f]{64}$/

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// Not a secret: it is a revocation epoch. Bumping it invalidates every
// outstanding token (guest links AND owner sessions). Defaults so a deploy
// without the env var set keeps working.
export function currentKeyVersion(): string {
  const kv = process.env.SHARE_KEY_VERSION ?? '1'
  if (!KEY_VERSION_RE.test(kv)) {
    throw new Error('SHARE_KEY_VERSION must be 1-32 alphanumeric characters')
  }
  return kv
}

function sign(payload: string): string {
  return createHmac('sha256', process.env.COOKIE_SECRET!).update(payload).digest('hex')
}

export function signSession(claims: { role: Role; expiresAt: number }): string {
  if (!ROLES.has(claims.role)) throw new Error('invalid role')
  if (!Number.isInteger(claims.expiresAt) || claims.expiresAt < 0) {
    throw new Error('expiresAt must be a non-negative integer (unix seconds)')
  }
  const exp = String(claims.expiresAt)
  if (!EXP_RE.test(exp)) throw new Error('expiresAt out of range')
  const payload = [FORMAT, claims.role, exp, currentKeyVersion()].join(FIELD_SEP)
  return `${payload}${SIG_SEP}${sign(payload)}`
}

export function verifySession(
  value: string | undefined,
  now: number = nowSeconds(),
): SessionClaims | null {
  if (!value) return null

  const parts = value.split(SIG_SEP)
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!SIG_RE.test(signature)) return null

  const fields = payload.split(FIELD_SEP)
  if (fields.length !== 4) return null
  const [format, role, exp, keyVersion] = fields
  if (format !== FORMAT) return null
  if (!ROLES.has(role)) return null
  if (!EXP_RE.test(exp)) return null
  if (!KEY_VERSION_RE.test(keyVersion)) return null

  let expectedKeyVersion: string
  try {
    expectedKeyVersion = currentKeyVersion()
  } catch {
    return null
  }
  if (keyVersion !== expectedKeyVersion) return null

  // Sign the payload exactly as received -- never a re-serialization of the
  // parsed fields -- so there is no canonicalization gap to exploit.
  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  const expiresAt = Number(exp)
  if (expiresAt <= now) return null

  return { role: role as Role, expiresAt, keyVersion }
}

export function remainingSeconds(claims: SessionClaims, now: number = nowSeconds()): number {
  return Math.max(0, claims.expiresAt - now)
}

// Only allow site-relative paths for `next`. Anything else falls back to
// '/' to prevent an open redirect through a crafted `?next=` value: an
// absolute URL, a protocol-relative URL (`//evil.example.com`), or a
// backslash variant (`/\evil.com`, `/\/evil.com`) that WHATWG URL parsing
// (browsers, and Node's URL) normalizes to a protocol-relative URL during
// relative resolution.
const SAFE_NEXT = /^\/(?!\/|\\)/

export function safeNext(next: string | null | undefined): string {
  if (!next || !SAFE_NEXT.test(next)) {
    return '/'
  }
  return next
}
```

Note the `SIG_RE` check before `timingSafeEqual`: it is what makes the "wrong length
never reaches the comparison" test pass, and it means junk input costs no HMAC.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/auth.test.ts`
Expected: PASS — all `session claims` and `safeNext` tests green.

- [ ] **Step 5: Confirm the two call sites now fail to compile (this is expected)**

Run: `npx tsc --noEmit`
Expected: errors in `proxy.ts` (`isValidSession` has no export) and
`app/enter/actions.ts` (`signSession` expects 1 argument). Task 2 fixes both. Do not
"fix" them here by re-adding `isValidSession`.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts lib/auth.test.ts
git commit -m "feat(auth): sign role, expiry, and key version into sessions"
```

---

## Task 2 — Call sites: proxy accepts any role, `/enter` mints an owner session

**Files:**
- Modify: `proxy.ts`
- Modify: `app/enter/actions.ts`

**Interfaces:**
- Consumes: `verifySession`, `signSession`, `nowSeconds`, `OWNER_SESSION_SECONDS`,
  `SESSION_COOKIE` from Task 1.
- Produces: a compiling app whose behaviour for owners is identical to today, except
  that every pre-existing cookie is now rejected (Design §8).

No new unit tests: neither file contains branching beyond what Task 1 already tests,
and the repo does not unit-test `proxy.ts` or server actions. The verification is
`tsc`, `lint`, the full suite, and a manual check.

- [ ] **Step 1: Update `proxy.ts`**

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from './lib/auth'

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  // Any valid role may view. Owner-only actions gate themselves in lib/share.
  if (verifySession(cookie)) {
    return NextResponse.next()
  }
  const url = new URL('/enter', request.url)
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!enter(?:/|$)|api/revalidate(?:/|$)|_next/static|_next/image|favicon\\.ico).*)',
  ],
}
```

(The `/s/` exclusion is added in Task 4 together with the route it protects, so the
matcher change and the route land in the same commit and cannot drift.)

- [ ] **Step 2: Update `app/enter/actions.ts`**

```ts
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  SESSION_COOKIE,
  OWNER_SESSION_SECONDS,
  signSession,
  nowSeconds,
  safeNext,
} from '../../lib/auth'

export async function submitPasscode(formData: FormData) {
  const passcode = formData.get('passcode')
  const next = safeNext(formData.get('next') as string | null)

  if (passcode !== process.env.SITE_PASSCODE) {
    redirect(`/enter?error=1&next=${encodeURIComponent(next)}`)
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, signSession({ role: 'owner', expiresAt: nowSeconds() + OWNER_SESSION_SECONDS }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OWNER_SESSION_SECONDS,
    path: '/',
  })
  redirect(next)
}
```

The signed expiry and the cookie `maxAge` are the same constant on purpose: the
browser and the server agree on when an owner session ends.

- [ ] **Step 3: Type-check, lint, and run the full suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all three clean. `npm test` shows every existing suite (`auth`, `facts`,
`gallery`, `queries`) passing.

- [ ] **Step 4: Manual check of the migration behaviour**

Run: `npm run dev` (with `.env.local` populated), then in a browser that still holds an
old `short_list_session` cookie, load `http://localhost:3000/`.
Expected: redirected to `/enter?next=/`. Enter the passcode. Expected: back on `/`
with listings. DevTools → Application → Cookies shows `short_list_session` whose value
starts with `v1-owner-` and expires in 90 days.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts app/enter/actions.ts
git commit -m "feat(auth): mint owner sessions; verify claims in proxy"
```

---

## Task 3 — `lib/share.ts`: durations, origin, link building, visit resolution

**Files:**
- Create: `lib/share.ts`
- Test: `lib/share.test.ts`

**Interfaces:**
- Consumes: `signSession`, `verifySession`, `remainingSeconds`, `nowSeconds`,
  `SessionClaims` from Task 1.
- Produces:

```ts
export const SHARE_DURATIONS: Readonly<Record<'24h' | '7d' | '30d', number>>  // seconds
export type ShareDuration = keyof typeof SHARE_DURATIONS
export function isShareDuration(value: unknown): value is ShareDuration
export function shareOrigin(headers: Headers): string | null
export type ShareLinkResult =
  | { ok: true; url: string; expiresAt: number }   // expiresAt: unix seconds
  | { ok: false; message: string }
export function buildShareLink(input: {
  cookie: string | undefined       // the caller's session cookie value
  duration: unknown                // raw FormData value; validated here
  requestHeaders: Headers
  now?: number
}): ShareLinkResult
export type ShareVisit =
  | { kind: 'set'; value: string; maxAge: number }  // set cookie to `value` for `maxAge` seconds, redirect to /
  | { kind: 'keep' }                                 // valid owner already present; just redirect to /
  | { kind: 'reject' }                               // redirect to /enter?error=link
export function resolveShareVisit(input: {
  token: string | undefined
  existingCookie: string | undefined
  now?: number
}): ShareVisit
```

`Headers` is the WHATWG global (Node 20 and the Next runtime both provide it), so tests
construct one with `new Headers({...})` and the server action passes the result of
`await headers()` straight through.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/share.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signSession, verifySession, OWNER_SESSION_SECONDS } from './auth'
import {
  SHARE_DURATIONS,
  isShareDuration,
  shareOrigin,
  buildShareLink,
  resolveShareVisit,
} from './share'

const NOW = 1_760_000_000
const VERCEL_HEADERS = new Headers({
  host: 'short-list.vercel.app',
  'x-forwarded-host': 'short-list.vercel.app',
  'x-forwarded-proto': 'https',
})

describe('share', () => {
  const originalSecret = process.env.COOKIE_SECRET
  const originalKeyVersion = process.env.SHARE_KEY_VERSION
  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
    process.env.SHARE_KEY_VERSION = '1'
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
    process.env.SHARE_KEY_VERSION = originalKeyVersion
  })

  const owner = () => signSession({ role: 'owner', expiresAt: NOW + OWNER_SESSION_SECONDS })
  const guest = (ttl = 3600) => signSession({ role: 'guest', expiresAt: NOW + ttl })

  describe('durations', () => {
    it('offers exactly 24h, 7d, and 30d', () => {
      expect(SHARE_DURATIONS).toEqual({ '24h': 86_400, '7d': 604_800, '30d': 2_592_000 })
    })
    it('isShareDuration is a strict allowlist', () => {
      expect(isShareDuration('7d')).toBe(true)
      for (const bad of ['1h', '90d', '', null, undefined, 7, '7d ', 'constructor', '__proto__']) {
        expect(isShareDuration(bad), String(bad)).toBe(false)
      }
    })
  })

  describe('shareOrigin', () => {
    it('prefers the forwarded host and proto (Vercel)', () => {
      expect(shareOrigin(VERCEL_HEADERS)).toBe('https://short-list.vercel.app')
    })
    it('falls back to host, with https for a real hostname', () => {
      expect(shareOrigin(new Headers({ host: 'example.com' }))).toBe('https://example.com')
    })
    it('falls back to http for localhost and loopback in dev', () => {
      expect(shareOrigin(new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
      expect(shareOrigin(new Headers({ host: '127.0.0.1:3000' }))).toBe('http://127.0.0.1:3000')
    })
    it('returns null when there is no host at all', () => {
      expect(shareOrigin(new Headers())).toBeNull()
    })
  })

  describe('buildShareLink', () => {
    it('an owner gets an absolute /s/<token> URL whose token verifies as a guest with the chosen expiry', () => {
      const result = buildShareLink({ cookie: owner(), duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.expiresAt).toBe(NOW + SHARE_DURATIONS['7d'])
      expect(result.url.startsWith('https://short-list.vercel.app/s/')).toBe(true)
      const token = result.url.slice('https://short-list.vercel.app/s/'.length)
      expect(verifySession(token, NOW)).toEqual({ role: 'guest', expiresAt: NOW + SHARE_DURATIONS['7d'], keyVersion: '1' })
    })

    it('the token needs no URL encoding', () => {
      const result = buildShareLink({ cookie: owner(), duration: '24h', requestHeaders: VERCEL_HEADERS, now: NOW })
      if (!result.ok) throw new Error('expected ok')
      expect(encodeURIComponent(result.url.split('/s/')[1])).toBe(result.url.split('/s/')[1])
    })

    it('a guest cannot mint a link (server-side gate, independent of the UI)', () => {
      const result = buildShareLink({ cookie: guest(), duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
      expect(result).toEqual({ ok: false, message: 'Only the passcode session can create share links.' })
    })

    it('no cookie, an expired owner cookie, or a tampered cookie cannot mint a link', () => {
      const expiredOwner = signSession({ role: 'owner', expiresAt: NOW - 1 })
      for (const cookie of [undefined, '', expiredOwner, owner() + 'x']) {
        const result = buildShareLink({ cookie, duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
        expect(result.ok, String(cookie)).toBe(false)
      }
    })

    it('rejects a duration outside the allowlist', () => {
      for (const duration of ['90d', '3600', '', null, undefined]) {
        const result = buildShareLink({ cookie: owner(), duration, requestHeaders: VERCEL_HEADERS, now: NOW })
        expect(result).toEqual({ ok: false, message: 'Pick a valid duration.' })
      }
    })

    it('fails clearly when the origin cannot be determined', () => {
      const result = buildShareLink({ cookie: owner(), duration: '7d', requestHeaders: new Headers(), now: NOW })
      expect(result).toEqual({ ok: false, message: 'Could not determine the site address.' })
    })
  })

  describe('resolveShareVisit', () => {
    it('a valid guest token with no existing cookie sets the cookie for its remaining life', () => {
      const token = guest(3600)
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW + 1000 })).toEqual({
        kind: 'set',
        value: token,
        maxAge: 2600,
      })
    })

    it('maxAge is never below 1 second for a token that is still valid', () => {
      const token = guest(1)
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW })).toEqual({ kind: 'set', value: token, maxAge: 1 })
    })

    it('a visitor who already holds a valid owner cookie is not downgraded', () => {
      expect(resolveShareVisit({ token: guest(), existingCookie: owner(), now: NOW })).toEqual({ kind: 'keep' })
    })

    it('a visitor holding a guest cookie gets the new link applied (may extend or shorten)', () => {
      const longer = guest(7200)
      expect(resolveShareVisit({ token: longer, existingCookie: guest(60), now: NOW })).toEqual({ kind: 'set', value: longer, maxAge: 7200 })
    })

    it('an expired or invalid existing owner cookie does not protect the visitor from a bad link', () => {
      const staleOwner = signSession({ role: 'owner', expiresAt: NOW - 1 })
      expect(resolveShareVisit({ token: 'junk', existingCookie: staleOwner, now: NOW })).toEqual({ kind: 'reject' })
    })

    it('rejects an expired token', () => {
      expect(resolveShareVisit({ token: guest(60), existingCookie: undefined, now: NOW + 60 })).toEqual({ kind: 'reject' })
    })

    it('rejects a tampered, empty, or missing token', () => {
      for (const token of [guest() + 'x', guest().replace('-guest-', '-owner-'), '', undefined]) {
        expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW }), String(token)).toEqual({ kind: 'reject' })
      }
    })

    it('rejects a token from a previous key version', () => {
      const token = guest()
      process.env.SHARE_KEY_VERSION = '2'
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW })).toEqual({ kind: 'reject' })
    })

    it('an OWNER-role value is never accepted as a share link', () => {
      // A leaked owner cookie must not be convertible into a URL that hands
      // out owner sessions. Owner sessions are minted only by the passcode.
      expect(resolveShareVisit({ token: owner(), existingCookie: undefined, now: NOW })).toEqual({ kind: 'reject' })
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/share.test.ts`
Expected: FAIL — `lib/share.ts` does not exist.

- [ ] **Step 3: Write `lib/share.ts`**

```ts
import { signSession, verifySession, remainingSeconds, nowSeconds } from './auth'

// Closed allowlist. The server action never accepts raw seconds, so 30 days
// is the hard ceiling on any link's life.
export const SHARE_DURATIONS = {
  '24h': 60 * 60 * 24,
  '7d': 60 * 60 * 24 * 7,
  '30d': 60 * 60 * 24 * 30,
} as const

export type ShareDuration = keyof typeof SHARE_DURATIONS

export function isShareDuration(value: unknown): value is ShareDuration {
  // hasOwn, not `in`: a string like 'constructor' must not match.
  return typeof value === 'string' && Object.hasOwn(SHARE_DURATIONS, value)
}

// Vercel sets x-forwarded-host / x-forwarded-proto on every deployment, and
// Next's server-action CSRF check has already verified Origin against
// Host / X-Forwarded-Host by the time an action runs, so these headers are
// the origin the owner's browser attested to. Falls back for `next dev`.
export function shareOrigin(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host') ?? headers.get('host')
  if (!host) return null
  const isLoopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  const proto = headers.get('x-forwarded-proto') ?? (isLoopback ? 'http' : 'https')
  return `${proto}://${host}`
}

export type ShareLinkResult =
  | { ok: true; url: string; expiresAt: number }
  | { ok: false; message: string }

export function buildShareLink(input: {
  cookie: string | undefined
  duration: unknown
  requestHeaders: Headers
  now?: number
}): ShareLinkResult {
  const now = input.now ?? nowSeconds()

  // Authorization first, and inside this function, so the gate holds for a
  // hand-crafted POST just as it does for the UI.
  const session = verifySession(input.cookie, now)
  if (!session || session.role !== 'owner') {
    return { ok: false, message: 'Only the passcode session can create share links.' }
  }
  if (!isShareDuration(input.duration)) {
    return { ok: false, message: 'Pick a valid duration.' }
  }
  const origin = shareOrigin(input.requestHeaders)
  if (!origin) {
    return { ok: false, message: 'Could not determine the site address.' }
  }

  const expiresAt = now + SHARE_DURATIONS[input.duration]
  const token = signSession({ role: 'guest', expiresAt })
  return { ok: true, url: `${origin}/s/${token}`, expiresAt }
}

export type ShareVisit =
  | { kind: 'set'; value: string; maxAge: number }
  | { kind: 'keep' }
  | { kind: 'reject' }

export function resolveShareVisit(input: {
  token: string | undefined
  existingCookie: string | undefined
  now?: number
}): ShareVisit {
  const now = input.now ?? nowSeconds()

  const claims = verifySession(input.token, now)
  // Owner sessions are minted only by the passcode; never by a URL.
  if (!claims || claims.role !== 'guest') return { kind: 'reject' }

  // Don't downgrade an owner who clicks their own link.
  const existing = verifySession(input.existingCookie, now)
  if (existing?.role === 'owner') return { kind: 'keep' }

  // The cookie can never outlive the link: its lifetime is what is left.
  return { kind: 'set', value: input.token!, maxAge: Math.max(1, remainingSeconds(claims, now)) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/share.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and type-check**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean. (`Object.hasOwn` needs `lib: ["esnext"]`, which `tsconfig.json`
already has.)

- [ ] **Step 6: Commit**

```bash
git add lib/share.ts lib/share.test.ts
git commit -m "feat(share): owner-gated link builder and visit resolver"
```

---

## Task 4 — `/s/[token]` route, proxy exclusion, and the failure message

**Files:**
- Create: `app/s/[token]/route.ts`
- Modify: `proxy.ts` (matcher only)
- Modify: `app/enter/page.tsx` (`error=link` message)

**Interfaces:**
- Consumes: `resolveShareVisit` (Task 3), `SESSION_COOKIE` (Task 1).
- Produces: the public entry point `GET /s/<token>`.

The route is a thin adapter — every decision is in `resolveShareVisit`, which Task 3
tested. The response is built explicitly with `NextResponse.redirect` plus
`response.cookies.set(...)` rather than `cookies().set()` + `redirect()`, so there is
no question of whether a thrown redirect carries the cookie. `303` so the browser
always follows with a GET. `Cache-Control: no-store` so no intermediary or back-button
cache replays a `Set-Cookie`.

- [ ] **Step 1: Write `app/s/[token]/route.ts`**

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth'
import { resolveShareVisit } from '@/lib/share'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const visit = resolveShareVisit({
    token,
    existingCookie: request.cookies.get(SESSION_COOKIE)?.value,
  })

  const destination =
    visit.kind === 'reject' ? new URL('/enter?error=link', request.url) : new URL('/', request.url)
  const response = NextResponse.redirect(destination, 303)
  response.headers.set('Cache-Control', 'no-store')

  if (visit.kind === 'set') {
    response.cookies.set(SESSION_COOKIE, visit.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: visit.maxAge,
      path: '/',
    })
  }
  return response
}
```

`sameSite: 'lax'` is correct for this flow: the link is opened as a top-level
navigation from a message app or another site, and lax cookies are sent on top-level
GET navigations, so the redirect to `/` arrives already authenticated.

- [ ] **Step 2: Exclude `/s/` from the proxy matcher**

In `proxy.ts`, change the matcher to:

```ts
export const config = {
  matcher: [
    '/((?!enter(?:/|$)|s(?:/|$)|api/revalidate(?:/|$)|_next/static|_next/image|favicon\\.ico).*)',
  ],
}
```

The `s(?:/|$)` alternative mirrors the existing `enter(?:/|$)` form so `/s/…` is
excluded but `/search`, `/sqft`, or a listing id starting with `s` is not.

- [ ] **Step 3: Show the link-failure message on `/enter`**

In `app/enter/page.tsx`, replace the single `{error && …}` line inside `PasscodeForm`
with:

```tsx
      {error === 'link' ? (
        <p className="enter-error">That share link is invalid or has expired — ask for a new one.</p>
      ) : error ? (
        <p className="enter-error">Wrong passcode — try again.</p>
      ) : null}
```

Nothing else in the file changes; the `next` hidden field and the Suspense wrapper
stay as they are.

- [ ] **Step 4: Type-check, lint, full suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: clean; the suite count is Task 3's plus nothing (no new unit tests here).

- [ ] **Step 5: Manual verification with curl**

With `npm run dev` running and `COOKIE_SECRET=…` matching `.env.local`, mint a
token from a one-off Node script (this is the only time a token is minted outside the
UI):

```bash
COOKIE_SECRET=$(grep ^COOKIE_SECRET .env.local | cut -d= -f2-) \
  npx tsx -e "import('./lib/auth.ts').then(m => console.log(m.signSession({ role: 'guest', expiresAt: m.nowSeconds() + 600 })))"
```

(If `tsx` is not installed, `npx --yes tsx` fetches it; it is not added to
`package.json`.) Then:

```bash
curl -si "http://localhost:3000/s/<token>" | grep -iE '^(HTTP|location|set-cookie|cache-control)'
```

Expected:
```
HTTP/1.1 303 See Other
Location: http://localhost:3000/
Set-Cookie: short_list_session=v1-guest-…; Path=/; Max-Age=6xx; HttpOnly; SameSite=lax
Cache-Control: no-store
```

Then a bad token:

```bash
curl -si "http://localhost:3000/s/v1-guest-9999999999-1.deadbeef" | grep -iE '^(HTTP|location|set-cookie)'
```

Expected: `303`, `Location: http://localhost:3000/enter?error=link`, **no**
`Set-Cookie`. Open that URL in a browser and confirm the link-failure message renders
above the passcode field.

Finally, confirm the proxy exclusion works: `curl -si http://localhost:3000/s/anything`
must return the `303` to `/enter?error=link` from the *route* (no `next` query
parameter), not the proxy's `302` to `/enter?next=%2Fs%2Fanything`.

- [ ] **Step 6: Commit**

```bash
git add app/s/[token]/route.ts proxy.ts app/enter/page.tsx
git commit -m "feat(share): redeem /s/<token> into a guest session"
```

---

## Task 5 — Share control on the list page (owners only)

**Files:**
- Create: `app/actions.ts`
- Create: `app/OwnerTools.tsx`
- Create: `app/ShareControl.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `buildShareLink`, `ShareLinkResult`, `SHARE_DURATIONS`, `ShareDuration`
  (Task 3); `verifySession`, `SESSION_COOKIE` (Task 1).
- Produces: `createShareLink(prev: ShareLinkState, formData: FormData): Promise<ShareLinkState>`
  where `export type ShareLinkState = ShareLinkResult | null`.

Layering: `OwnerTools` (server, async) reads the cookie once and renders
`<ShareControl />` only for `role === 'owner'`. It must be mounted inside its own
`<Suspense>` in `app/page.tsx` — with `cacheComponents: true`, calling `cookies()`
outside a boundary is a build error, and its own boundary keeps the rest of the header
in the static shell. `ShareControl` (client) drives the server action with
`useActionState`, which gives it the `pending` flag and the returned URL in one hook.
Hiding the control from guests is UX, not security — `buildShareLink` re-checks the
role on every call (Task 3 test "a guest cannot mint a link").

- [ ] **Step 1: Write `app/actions.ts`**

```ts
'use server'

import { cookies, headers } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/auth'
import { buildShareLink, type ShareLinkResult } from '@/lib/share'

export type ShareLinkState = ShareLinkResult | null

export async function createShareLink(
  _prev: ShareLinkState,
  formData: FormData,
): Promise<ShareLinkState> {
  const jar = await cookies()
  const requestHeaders = await headers()
  return buildShareLink({
    cookie: jar.get(SESSION_COOKIE)?.value,
    duration: formData.get('duration'),
    requestHeaders,
  })
}
```

The action holds no logic of its own: the return shape is already "what the UI
renders, not raw records", and authorization happens inside `buildShareLink`.

- [ ] **Step 2: Write `app/OwnerTools.tsx`**

```tsx
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { ShareControl } from './ShareControl'

// Reads the request cookie, so it must render inside a <Suspense> boundary
// (Cache Components). Renders nothing for guests -- and nothing for a page
// somehow reached without a session, which the proxy already prevents.
export async function OwnerTools() {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (session?.role !== 'owner') return null
  return <ShareControl />
}
```

- [ ] **Step 3: Write `app/ShareControl.tsx`**

```tsx
'use client'

import { useActionState, useState } from 'react'
import { createShareLink } from './actions'
import { SHARE_DURATIONS, type ShareDuration } from '@/lib/share'

const DURATION_LABELS: Record<ShareDuration, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
}

export function ShareControl() {
  const [state, formAction, pending] = useActionState(createShareLink, null)
  const [copied, setCopied] = useState(false)

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable (http, permissions). The input below is
      // selectable, so the user can still copy by hand.
    }
  }

  return (
    <div className="share">
      <form action={formAction} className="share-form">
        <label className="share-label" htmlFor="share-duration">Share for</label>
        <select id="share-duration" name="duration" className="sort" defaultValue="7d">
          {(Object.keys(SHARE_DURATIONS) as ShareDuration[]).map((d) => (
            <option key={d} value={d}>{DURATION_LABELS[d]}</option>
          ))}
        </select>
        <button type="submit" className="chip" disabled={pending}>
          {pending ? 'Creating…' : 'Create link'}
        </button>
      </form>

      {state?.ok ? (
        <div className="share-result">
          <input
            className="share-url"
            readOnly
            value={state.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Share link"
          />
          <button type="button" className="chip" onClick={() => copy(state.url)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="share-expiry">
            Expires {new Date(state.expiresAt * 1000).toLocaleString()}
          </span>
        </div>
      ) : null}

      {state && !state.ok ? <p className="enter-error">{state.message}</p> : null}
    </div>
  )
}
```

`toLocaleString()` only renders after the action returns (client state), so there is
no server/client hydration mismatch. Reusing `.sort` and `.chip` keeps the control
visually in the existing header language.

- [ ] **Step 4: Mount it in `app/page.tsx`**

Add the import and a sibling `<Suspense>` after the existing `ListControls` one:

```tsx
import { OwnerTools } from './OwnerTools'
// …inside <div className="app-inner">, directly after the ListControls Suspense:
          <Suspense fallback={null}>
            <OwnerTools />
          </Suspense>
```

`fallback={null}`: guests and the static shell render nothing here, so a placeholder
would only add layout shift for the 99% case.

- [ ] **Step 5: Add the CSS**

Append to the header block in `app/globals.css` (near `.chips` on ~line 97):

```css
  .share{ display:flex; flex-direction:column; gap:8px; }
  .share-form{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .share-label{ font-size:12px; font-weight:700; color: var(--ink-2); }
  .share-result{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .share-url{ flex:1; min-width:200px; border:1px solid var(--line); border-radius: var(--radius-m); padding:7px 10px; font-size:12.5px; font-family: var(--font-geist-mono), monospace; color: var(--ink); background: var(--surface); }
  .share-expiry{ font-size:12px; color: var(--ink-3); }
```

- [ ] **Step 6: Type-check, lint, full suite, build**

Run: `npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: all clean. `npm run build` is the step that would fail if `OwnerTools` were
outside a `<Suspense>` boundary ("Next.js encountered runtime data during
prerendering") — its passing is the verification that the Cache Components constraint
is met.

- [ ] **Step 7: Manual end-to-end**

`npm run dev`, then:

1. As an owner (passcode session): the header shows "Share for [7 days] [Create link]".
   Click Create link. Expected: a `http://localhost:3000/s/v1-guest-…` URL appears with
   "Expires <date 7 days out>"; Copy puts it on the clipboard.
2. Open a private window, paste the URL. Expected: land on `/` with listings; the
   header shows **no** share control. Cookie value starts with `v1-guest-`; its
   expiry matches the link's, not 90 days.
3. In that private window, submit a hand-crafted action POST is impractical — instead
   confirm the server gate with the Task 3 unit test (`a guest cannot mint a link`),
   which is the contract the UI relies on.
4. Back in the owner window, open the *same* share URL. Expected: still an owner
   (share control still visible) — `resolveShareVisit` returned `keep`.
5. Bump `SHARE_KEY_VERSION=2` in `.env.local`, restart dev. Expected: both windows are
   bounced to `/enter`; the private window's link now lands on `/enter?error=link`.

- [ ] **Step 8: Commit**

```bash
git add app/actions.ts app/OwnerTools.tsx app/ShareControl.tsx app/page.tsx app/globals.css
git commit -m "feat(share): owner-only share control with expiry picker"
```

---

## Task 6 — Documentation and final verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (environment variables table)
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:** none. This task changes no code.

- [ ] **Step 1: `.env.example`**

Append after the `COOKIE_SECRET=` line:

```
# Revocation epoch for share links. Not a secret. Bump it (1 -> 2 -> 3 ...) to
# invalidate every outstanding share link at once. Owner sessions carry it
# too, so a bump also logs both of you out until you re-enter the passcode.
# Optional; defaults to 1. Must be 1-32 letters/digits.
SHARE_KEY_VERSION=1
```

And extend the `COOKIE_SECRET` comment so it reads:

```
# Passcode required to view the site, and the secret used to sign the
# session cookie issued after a correct passcode AND every share link. Keep
# COOKIE_SECRET random and private; anyone with it can forge a valid session.
```

- [ ] **Step 2: `README.md`**

Add a row to the environment variables table after `COOKIE_SECRET`:

```
| `SHARE_KEY_VERSION` | Optional, default `1`. Bump to invalidate every outstanding share link (also logs owners out once). |
```

- [ ] **Step 3: `docs/DEPLOYMENT.md`**

Three edits:

1. In **§3 "Set the remaining app secrets"**, after the `vercel env add REVALIDATE_SECRET`
   line add:

   ```bash
   vercel env add SHARE_KEY_VERSION production  # optional; "1" -- bump to kill all share links
   ```

   and replace the paragraph beginning "`COOKIE_SECRET` signs the session cookie" with:

   > `COOKIE_SECRET` signs the session cookie *and* every share link. Rotating it logs
   > everyone out and kills every link — use it if the secret itself may have leaked.
   > For the lighter case of "a share link got forwarded further than I wanted", bump
   > `SHARE_KEY_VERSION` instead: every outstanding link dies, and you and Megan
   > re-enter the passcode once. There is no per-link revocation by design (no
   > server-side state; the app's Turso token is read-only).

2. In **§7 "Verify end-to-end"**, append:

   > Then, as the passcode session, use "Share for 24 hours → Create link", open the
   > link in a private window, and confirm it shows the list *without* the share
   > control. Its cookie should expire when the link does, not in 90 days.

3. In **"Known trade-offs, decided deliberately"**, add a bullet:

   > - **Share links are stateless bearer tokens.** Anyone holding an unexpired link can
   >   view the list and can forward the link; the only controls are the expiry you
   >   picked (24h/7d/30d) and the all-or-nothing `SHARE_KEY_VERSION` bump. Deploying
   >   the share-link change invalidated every previously issued session cookie once
   >   (the payload format changed); that was accepted rather than carrying a
   >   dual-format grace period in a security module.

- [ ] **Step 4: Final verification**

Run: `npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: clean. `npm test` reports the four pre-existing suites plus `lib/auth.test.ts`
(rewritten) and `lib/share.test.ts` (new), all passing.

Run: `git status --short`
Expected: only the three doc files modified (plus any untracked local-only files that
pre-date this work, e.g. `.claude/`, `.agents/`).

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md docs/DEPLOYMENT.md
git commit -m "docs: document SHARE_KEY_VERSION and share-link revocation"
```

- [ ] **Step 6: Open the PR**

Use the `/pr` skill (repo convention). Title: `feat(share): expiring share links for guests`.
Body: Summary → Changes → Test plan, with the manual checks from Task 4 Step 5 and
Task 5 Step 7 as checkboxes, and one explicit line: "Deploying this logs both of us out
once — the cookie format changed." Assignee: BenGiese22.

---

## Security test matrix (cross-reference)

Every case the design called out, and where it is pinned:

| Case | Test |
|------|------|
| Expired token | auth: "valid one second before expiry and invalid at expiry"; share: "rejects an expired token" |
| Tampered signature | auth: "a tampered signature is invalid"; share: "rejects a tampered, empty, or missing token" |
| Tampered expiry | auth: "a tampered expiry (extended, signature kept) is invalid" |
| Tampered role | auth: "a tampered role (guest promoted to owner…)"; share: same list |
| Wrong key version | auth: "…invalid once the version is bumped to 2" (guest and owner); share: "rejects a token from a previous key version" |
| Guest attempting to generate a link | share: "a guest cannot mint a link (server-side gate…)" |
| No / expired / tampered owner cookie generating a link | share: "no cookie, an expired owner cookie, or a tampered cookie cannot mint a link" |
| Owner cookie used as a share URL | share: "an OWNER-role value is never accepted as a share link" |
| Owner not downgraded by their own link | share: "…valid owner cookie is not downgraded" |
| Timing-safe comparison | auth: "compares signatures with timingSafeEqual" and "does not reach timingSafeEqual when the shape is already wrong" |
| Field injection via key version | auth: "signSession refuses a key version containing a separator…" and "verifySession refuses a key version containing a separator even if the env matches" |
| Field injection via extra fields / dots | auth: "extra fields or extra dots are refused even when correctly signed" |
| Unknown role / format | auth: "an unknown role is refused…", "an unknown format version is refused" |
| Non-numeric / padded expiry | auth: "a non-numeric or padded expiry is refused" |
| Legacy cookie after deploy | auth: "the pre-v1 'authenticated.<sig>' cookie is rejected" |
| Duration outside the allowlist (incl. prototype keys) | share: "isShareDuration is a strict allowlist", "rejects a duration outside the allowlist" |
| Cookie cannot outlive the link | share: "sets the cookie for its remaining life" |
| Different secret | auth: "a token signed under a different secret is invalid" |

## Self-review notes

- **Spec coverage:** design items 1–7 map to Tasks 1 (encoding, verify, key version,
  secret), 2 (owner role), 3 (guest gating, remaining life, origin), 4 (route, matcher,
  failure landing), 5 (UI, action), 6 (env/deploy docs, migration note). Migration is
  Design §8 + Task 1's legacy test + Task 2 Step 4.
- **Type consistency:** `verifySession(value, now?)`, `signSession({ role, expiresAt })`,
  `remainingSeconds(claims, now?)`, `nowSeconds()`, `OWNER_SESSION_SECONDS`,
  `SESSION_COOKIE` are used with the same names and shapes in Tasks 2–5;
  `buildShareLink`, `resolveShareVisit`, `ShareLinkResult`, `SHARE_DURATIONS`,
  `ShareDuration` likewise. All times are **unix seconds** everywhere — `nowSeconds()`
  is the only place `Date.now()` appears.
- **Placeholders:** none; every code step is complete.
