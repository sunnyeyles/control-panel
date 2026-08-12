/**
 * Where OAuth should send the browser back to, decided on the server.
 *
 * Its own module with no imports: what it serves is a client component, and a
 * rule expressed inline at the call site is a rule nothing can exercise.
 *
 * ⚠️ **The origin this returns has to be a Neon Auth trusted domain, or sign-in
 * does not start at all.** The auth server checks `callbackURL` against the
 * allowlist *before* the provider, answering `403 INVALID_CALLBACKURL`.
 *
 * Vercel mints a fresh `control-panel-<hash>-….vercel.app` host per deployment,
 * so `window.location.origin` on a preview names a host nobody has trusted and
 * nobody sensibly could. `VERCEL_BRANCH_URL` is the stable per-branch alias, so
 * one `neon neon-auth domain add` per branch covers every build on it — and the
 * session cookie is set for the origin OAuth returns to, so landing on the alias
 * is the point rather than a side effect.
 *
 * Nothing here adds that entry; `.github/workflows/preview-auth-domain.yml`
 * does, against main's instance, which is the list a preview falling back to
 * main's `NEON_AUTH_BASE_URL` is checked against.
 *
 * A wildcard is not the alternative: Neon wildcards a whole hostname segment
 * and Vercel varies the hash *inside* the first label, so the only pattern that
 * matches is `https://*.vercel.app` — every Vercel site on the internet.
 */

export interface CallbackOriginEnv {
  readonly VERCEL_ENV?: string | undefined
  readonly VERCEL_BRANCH_URL?: string | undefined
  /**
   * Present so `process.env` is assignable. Both named members are optional,
   * which makes this a "weak type" — and TypeScript rejects a `ProcessEnv`
   * argument outright (TS2559) because its index signature declares neither
   * name explicitly. The two names above are what this module reads; the index
   * signature only widens what may be passed in.
   */
  readonly [key: string]: string | undefined
}

/**
 * The origin to hand to `signIn.social`, or `undefined` to mean "use
 * `window.location.origin`".
 *
 * Preview only, deliberately. Production and local development already land on
 * an origin the allowlist knows — the production domain is on it, and localhost
 * is covered by `neon neon-auth domain allow-localhost` — so rewriting those
 * here would put the two environments that currently work behind a variable
 * this function has no reason to second-guess.
 */
export function resolveCallbackOrigin(
  env: CallbackOriginEnv
): string | undefined {
  if (env.VERCEL_ENV?.trim() !== "preview") return undefined

  const branchUrl = env.VERCEL_BRANCH_URL?.trim()
  if (!branchUrl) return undefined

  return toOrigin(branchUrl)
}

/**
 * Vercel supplies these as bare hosts — `control-panel-git-main-….vercel.app`,
 * no scheme — while a trusted domain is compared as a full origin. Parsing
 * rather than concatenating is what keeps a value that already carries a scheme,
 * a trailing slash, or a stray path from producing an origin that fails the
 * comparison for a reason nobody would guess from the error.
 */
function toOrigin(value: string): string | undefined {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`

  try {
    // `.origin`, not `.href`: `href` reintroduces the trailing slash that the
    // allowlist does not forgive.
    return new URL(withScheme).origin
  } catch {
    // Unparseable means fall back to `window.location.origin`, which is where
    // this started — a worse guess, but not a blank sign-in page.
    return undefined
  }
}
