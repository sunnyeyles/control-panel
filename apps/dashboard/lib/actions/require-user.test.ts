/**
 * The authorization seam itself, asserted once.
 *
 * Every action suite used to re-prove these three properties through its own
 * action — six copies of "refused gets the anonymous caller's exact words" and
 * two byte-similar copies of the thrown-`getUser` case. They are `requireUser`'s
 * to hold, so they live here; what each call site still owns is the ordering —
 * that *its* store, model or database is untouched when the answer is no — and
 * that is the one assertion left in each.
 */

import { describe, expect, it, vi } from "vitest"

import {
  ANONYMOUS,
  REFUSED,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import { NOT_AUTHORIZED, requireUser } from "./require-user"

describe("requireUser", () => {
  it("resolves the signed-in caller to the platform user id", async () => {
    expect(await requireUser(async () => SIGNED_IN, "test")).toEqual({
      ok: true,
      userId: USER_ID,
    })
  })

  it("gives a refused caller the identical answer an anonymous one gets", async () => {
    // ⚠️ The non-disclosure property. `REFUSED` is a real session that
    // `AUTH_ALLOWED_EMAILS` turned away; a different message would confirm to
    // someone outside the list that their sign-in worked.
    const anonymous = await requireUser(async () => ANONYMOUS, "test")
    const refused = await requireUser(async () => REFUSED, "test")

    expect(anonymous).toEqual({ ok: false, message: NOT_AUTHORIZED })
    expect(refused).toEqual(anonymous)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    // `getCurrentUser` touches Postgres to map the auth id onto a platform
    // user. A database blip must not become an unauthenticated write.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(
      await requireUser(async () => {
        throw new Error("connection refused")
      }, "test")
    ).toEqual({ ok: false, message: NOT_AUTHORIZED })

    // Silently swallowing the cause would leave the outage undiagnosable.
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })
})
