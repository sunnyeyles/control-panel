import type { Agent } from "@workspace/agents"
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

import { createChatHandler } from "./chat-handler"

function request(sessionId: string): Request {
  return new Request("https://example.test/api/chat", {
    body: JSON.stringify({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "What time is it?" }],
        },
      ],
      sessionId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("createChatHandler", () => {
  it("adds trusted user and conversation context to Langfuse", async () => {
    const stream = vi.fn(async () =>
      (async function* () {
        yield ["values", { messages: [], llmCalls: 0 }]
      })()
    )
    const callback = { name: "langfuse" }
    createLangfuseCallback.mockReturnValue(callback)

    const handle = createChatHandler({
      createAgent: () => ({ stream }) as unknown as Agent,
      getUser: async () => ({
        status: "ok",
        userId: "22222222-2222-4222-8222-222222222222",
        email: "candidate@example.test",
        name: "Candidate",
      }),
    })

    const response = await handle(
      request("11111111-1111-4111-8111-111111111111")
    )

    expect(response.status).toBe(200)
    expect(createLangfuseCallback).toHaveBeenCalledWith({
      userId: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
      tags: ["dashboard", "chat"],
      traceMetadata: {
        feature: "chat",
        route: "/api/chat",
      },
    })
    expect(stream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        callbacks: [callback],
        metadata: {
          langfuseSessionId: "11111111-1111-4111-8111-111111111111",
          langfuseUserId: "22222222-2222-4222-8222-222222222222",
        },
        runName: "chat-response",
      })
    )
  })
})
