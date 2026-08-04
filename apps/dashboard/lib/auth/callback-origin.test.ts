import { describe, expect, it } from "vitest"

import { resolveCallbackOrigin } from "./callback-origin"

/** The shape Vercel actually sets: a bare host, no scheme. */
const PREVIEW = {
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL:
    "control-panel-git-my-branch-sunnys-projects-8f69bfb9.vercel.app",
}

describe("resolveCallbackOrigin", () => {
  it("returns the branch alias on a preview deployment", () => {
    // The whole point. The deployment's own host is `…-<hash>-…`, which is not
    // a trusted domain and cannot be made into one per build.
    expect(resolveCallbackOrigin(PREVIEW)).toBe(
      "https://control-panel-git-my-branch-sunnys-projects-8f69bfb9.vercel.app"
    )
  })

  it("adds the scheme, because Vercel supplies a bare host", () => {
    expect(resolveCallbackOrigin(PREVIEW)).toMatch(/^https:\/\//)
  })

  it("emits no trailing slash, which the allowlist does not forgive", () => {
    expect(resolveCallbackOrigin(PREVIEW)).not.toMatch(/\/$/)
  })

  it("defers to the browser in production", () => {
    // Production already lands on a trusted origin. Rewriting it here would put
    // the environment that works behind this function's guess.
    expect(
      resolveCallbackOrigin({
        VERCEL_ENV: "production",
        VERCEL_BRANCH_URL: "control-panel-git-main-x.vercel.app",
      })
    ).toBeUndefined()
  })

  it("defers to the browser off Vercel entirely", () => {
    // `next dev`, where the origin is localhost and `allow-localhost` covers it.
    expect(resolveCallbackOrigin({})).toBeUndefined()
  })

  it("defers to the browser when the branch alias is missing", () => {
    // Better a host that might be untrusted than no sign-in button behaviour at
    // all.
    expect(resolveCallbackOrigin({ VERCEL_ENV: "preview" })).toBeUndefined()
  })

  it("treats a blank branch alias as missing", () => {
    expect(
      resolveCallbackOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "   " })
    ).toBeUndefined()
  })

  it("tolerates the trailing newline these values arrive with", () => {
    // Every Vercel value set by piping in this project carries one — see the
    // production `NEON_AUTH_BASE_URL`. Untrimmed, `new URL` keeps it and the
    // origin no longer matches the allowlist entry.
    expect(
      resolveCallbackOrigin({
        VERCEL_ENV: "preview\n",
        VERCEL_BRANCH_URL: "control-panel-git-b-x.vercel.app\n",
      })
    ).toBe("https://control-panel-git-b-x.vercel.app")
  })

  it("keeps a value that already carries a scheme from being double-prefixed", () => {
    expect(
      resolveCallbackOrigin({
        VERCEL_ENV: "preview",
        VERCEL_BRANCH_URL: "https://control-panel-git-b-x.vercel.app",
      })
    ).toBe("https://control-panel-git-b-x.vercel.app")
  })

  it("drops a stray path rather than sending it as part of the origin", () => {
    expect(
      resolveCallbackOrigin({
        VERCEL_ENV: "preview",
        VERCEL_BRANCH_URL: "control-panel-git-b-x.vercel.app/",
      })
    ).toBe("https://control-panel-git-b-x.vercel.app")
  })

  it("falls back rather than throwing on an unparseable host", () => {
    expect(
      resolveCallbackOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "::" })
    ).toBeUndefined()
  })

  it("does not fire on an environment that merely starts with preview", () => {
    expect(
      resolveCallbackOrigin({
        VERCEL_ENV: "preview-something",
        VERCEL_BRANCH_URL: "control-panel-git-b-x.vercel.app",
      })
    ).toBeUndefined()
  })
})
