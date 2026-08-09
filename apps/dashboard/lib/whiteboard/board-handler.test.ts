import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: vi.fn(),
}))

import { createBoardHandler, MAX_SNAPSHOT_BYTES } from "./board-handler"

const USER_ID = "22222222-2222-4222-8222-222222222222"

const signedIn = async () =>
  ({
    status: "ok",
    userId: USER_ID,
    email: "candidate@example.test",
    name: "Candidate",
  }) as const

function request(body: string): Request {
  return new Request("https://example.test/api/whiteboard/board", {
    body,
    headers: { "content-type": "application/json" },
    method: "PUT",
  })
}

describe("createBoardHandler", () => {
  it("saves the snapshot against the caller from the session, never the body", async () => {
    // The body carries a userId; it must be ignored. Identity comes from the
    // session or the write is an authorization decision taken from a payload.
    const save = vi.fn(async () => {})
    const handle = createBoardHandler({ getUser: signedIn, save })

    const response = await handle(
      request(
        JSON.stringify({
          snapshot: { store: {} },
          userId: "33333333-3333-4333-8333-333333333333",
        })
      )
    )

    expect(response.status).toBe(204)
    expect(save).toHaveBeenCalledWith(USER_ID, { store: {} })
  })

  it("refuses an anonymous caller", async () => {
    const save = vi.fn(async () => {})
    const handle = createBoardHandler({
      getUser: async () => ({ status: "anonymous" }) as never,
      save,
    })

    expect((await handle(request("{}"))).status).toBe(401)
    expect(save).not.toHaveBeenCalled()
  })

  it("refuses an oversized board before parsing it", async () => {
    const save = vi.fn(async () => {})
    const handle = createBoardHandler({ getUser: signedIn, save })

    const response = await handle(request("x".repeat(MAX_SNAPSHOT_BYTES + 1)))

    expect(response.status).toBe(413)
    expect(save).not.toHaveBeenCalled()
  })

  it("measures the limit in bytes, not characters", async () => {
    // "€" is one UTF-16 code unit but three UTF-8 bytes, so a limit compared
    // against `string.length` would let this body through at ~3× the cap.
    const save = vi.fn(async () => {})
    const handle = createBoardHandler({ getUser: signedIn, save })

    const oversized = "€".repeat(Math.floor(MAX_SNAPSHOT_BYTES / 3) + 1)

    const response = await handle(request(oversized))

    expect(response.status).toBe(413)
    expect(save).not.toHaveBeenCalled()
  })

  it("rejects a body that is not JSON", async () => {
    const handle = createBoardHandler({
      getUser: signedIn,
      save: vi.fn(async () => {}),
    })

    expect((await handle(request("not json"))).status).toBe(400)
  })

  it("rejects a snapshot that is not an object, which is what a client bug looks like", async () => {
    const handle = createBoardHandler({
      getUser: signedIn,
      save: vi.fn(async () => {}),
    })

    expect(
      (await handle(request(JSON.stringify({ snapshot: "oops" })))).status
    ).toBe(400)
    expect((await handle(request(JSON.stringify({})))).status).toBe(400)
  })

  it("answers 500 rather than throwing when the write fails", async () => {
    const handle = createBoardHandler({
      getUser: signedIn,
      save: async () => {
        throw new Error("connection terminated")
      },
    })

    const response = await handle(
      request(JSON.stringify({ snapshot: { store: {} } }))
    )

    expect(response.status).toBe(500)
  })
})
