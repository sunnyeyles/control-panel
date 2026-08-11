import type { BoardContext } from "@workspace/agent-tools/canvas-schema"
import type { WhiteboardSession } from "@workspace/agents/whiteboard"
import { describe, expect, it, vi } from "vitest"

const { createLangfuseCallback } = vi.hoisted(() => ({
  createLangfuseCallback: vi.fn(),
}))

vi.mock("@workspace/langfuse", () => ({
  createLangfuseCallback,
}))

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: vi.fn(),
}))

import { createWhiteboardHandler } from "./whiteboard-handler"

const USER_ID = "22222222-2222-4222-8222-222222222222"
const SESSION_ID = "11111111-1111-4111-8111-111111111111"

const BOARD: BoardContext = {
  shapes: [{ id: "s1", kind: "rectangle", x: 0, y: 0, w: 200, h: 120 }],
  connections: [],
  selection: ["s1"],
  viewport: { x: 0, y: 0, w: 1200, h: 800 },
  recentEdits: [],
}

function request(body: unknown): Request {
  return new Request("https://example.test/api/whiteboard", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Draw a box" }],
      },
    ],
    board: BOARD,
    sessionId: SESSION_ID,
    ...overrides,
  }
}

function fakeSession(stream: ReturnType<typeof vi.fn>) {
  return { agent: { stream } } as unknown as WhiteboardSession
}

function emptyStream() {
  return vi.fn(async () =>
    (async function* () {
      yield ["values", { messages: [], llmCalls: 0 }]
    })()
  )
}

const signedIn = async () =>
  ({
    status: "ok",
    userId: USER_ID,
    email: "candidate@example.test",
    name: "Candidate",
  }) as const

describe("authorization", () => {
  it("refuses an anonymous caller before it parses the body", async () => {
    const createWhiteboardAgent = vi.fn()
    const handle = createWhiteboardHandler({
      createWhiteboardAgent,
      getUser: async () => ({ status: "anonymous" }) as never,
    })

    // Deliberately unparseable. A 401 rather than a 400 proves the gate ran
    // first — an unauthenticated caller learns nothing about what a
    // well-formed request looks like.
    const response = await handle(
      new Request("https://example.test/api/whiteboard", {
        body: "not json",
        method: "POST",
      })
    )

    expect(response.status).toBe(401)
    expect(createWhiteboardAgent).not.toHaveBeenCalled()
  })

  it("refuses a signed-in caller who is not on the allowlist, with the same 401", async () => {
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: vi.fn(),
      getUser: async () => ({ status: "refused" }) as never,
    })

    expect((await handle(request(validBody()))).status).toBe(401)
  })
})

describe("validation", () => {
  it("rejects a board that does not match the shared contract", async () => {
    const createWhiteboardAgent = vi.fn()
    const handle = createWhiteboardHandler({
      createWhiteboardAgent,
      getUser: signedIn,
    })

    const response = await handle(
      request(validBody({ board: { shapes: [{ id: "s1", kind: "sphere" }] } }))
    )

    expect(response.status).toBe(400)
    expect(createWhiteboardAgent).not.toHaveBeenCalled()
  })

  it("rejects a request carrying no board at all", async () => {
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: vi.fn(),
      getUser: signedIn,
    })

    const withoutBoard = validBody()
    delete (withoutBoard as { board?: unknown }).board

    expect((await handle(request(withoutBoard))).status).toBe(400)
  })

  it("rejects malformed messages", async () => {
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: vi.fn(),
      getUser: signedIn,
    })

    expect(
      (await handle(request(validBody({ messages: [{ role: "user" }] }))))
        .status
    ).toBe(400)
  })
})

describe("the run", () => {
  it("hands the agent the board it was sent, and a turn id to group ops by", async () => {
    const createWhiteboardAgent = vi.fn(() => fakeSession(emptyStream()))
    const handle = createWhiteboardHandler({
      createWhiteboardAgent,
      getUser: signedIn,
    })

    const response = await handle(request(validBody()))

    expect(response.status).toBe(200)
    expect(createWhiteboardAgent).toHaveBeenCalledWith({
      context: BOARD,
      turnId: expect.any(String),
    })
  })

  it("streams in custom mode as well, which is what carries the canvas ops", async () => {
    const stream = emptyStream()
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: () => fakeSession(stream),
      getUser: signedIn,
    })

    await handle(request(validBody()))

    expect(stream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        streamMode: ["values", "messages", "custom"],
        runName: "whiteboard-turn",
      })
    )
  })

  it("traces the turn against the caller and their session", async () => {
    const callback = { name: "langfuse" }
    createLangfuseCallback.mockReturnValue(callback)
    const stream = emptyStream()
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: () => fakeSession(stream),
      getUser: signedIn,
    })

    await handle(request(validBody()))

    expect(createLangfuseCallback).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      tags: ["dashboard", "whiteboard"],
      traceMetadata: {
        feature: "whiteboard",
        route: "/api/whiteboard",
        shapes: "1",
      },
    })
    expect(stream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ callbacks: [callback] })
    )
  })

  it("answers 500 rather than throwing when the agent cannot be built", async () => {
    const handle = createWhiteboardHandler({
      createWhiteboardAgent: () => {
        throw new Error("OPENAI_API_KEY is not set")
      },
      getUser: signedIn,
    })

    const response = await handle(request(validBody()))

    expect(response.status).toBe(500)
    // The real reason stays in the server log; the client is told only that
    // the agent is unavailable.
    await expect(response.json()).resolves.toEqual({
      error: "The agent is unavailable.",
    })
  })
})
