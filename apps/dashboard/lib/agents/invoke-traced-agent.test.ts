/**
 * What the three actions stopped spelling out for themselves.
 *
 * The properties here used to be asserted three times over, once per action,
 * and only ever incidentally — a suite about drafting a letter checked the run
 * name on its way past. They are about tracing rather than about any feature, so
 * they belong to one file, and the actions' own suites are left asserting the
 * thing they are about: that the *right* agent is reached with the *right*
 * prompt, and never reached at all when a refusal comes first.
 */

import type { Agent } from "@workspace/agents"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { createLangfuseCallback } = vi.hoisted(() => ({
  createLangfuseCallback: vi.fn(),
}))

vi.mock("@workspace/langfuse", () => ({ createLangfuseCallback }))

import { invokeTracedAgent } from "./invoke-traced-agent"

const USER_ID = "11111111-2222-4333-8444-555555555555"

interface Call {
  input: { messages: { role: string; content: string }[] }
  config: {
    runName?: string
    callbacks?: unknown[]
    metadata?: { langfuseUserId?: string; langfuseSessionId?: string }
  }
}

/** An agent that answers with fixed text and records how it was called. */
function fakeAgent(reply: string) {
  const calls: Call[] = []

  const agent = {
    async invoke(input: Call["input"], config: Call["config"]) {
      calls.push({ input, config })
      return { messages: [{ text: reply }] }
    },
  } as unknown as Agent

  return { agent, calls }
}

function run(overrides: Partial<Parameters<typeof invokeTracedAgent>[1]> = {}) {
  return {
    name: "cover-letter",
    route: "/jobs",
    userId: USER_ID,
    prompt: "Write a letter.",
    ...overrides,
  }
}

describe("invokeTracedAgent", () => {
  // `mock.calls` accumulates, and several assertions below read call [0] or
  // count invocations — so the recorded calls have to start empty each time.
  beforeEach(() => {
    createLangfuseCallback.mockReset()
  })

  it("returns the model's last message, trimmed", async () => {
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent } = fakeAgent(
      "  Dear Hiring Team,\n\nI would like to apply.  "
    )

    expect(await invokeTracedAgent(agent, run())).toBe(
      "Dear Hiring Team,\n\nI would like to apply."
    )
  })

  it("passes the prompt through as the only user message", async () => {
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent, calls } = fakeAgent("ok")

    await invokeTracedAgent(agent, run({ prompt: "Tailor this CV." }))

    expect(calls[0]?.input.messages).toEqual([
      { role: "user", content: "Tailor this CV." },
    ])
  })

  it("spells the run's name in all four of the places that must agree", async () => {
    // ⚠️ The whole reason this function exists. Three copies spelled the run
    // name, the Langfuse feature and the second tag separately, so a rename
    // could land in two of the three and leave a Langfuse view quietly matching
    // nothing.
    createLangfuseCallback.mockReturnValue({ name: "langfuse" })
    const { agent, calls } = fakeAgent("")

    await expect(
      invokeTracedAgent(agent, run({ name: "tailored-resume" }))
    ).rejects.toThrow(/tailored-resume/)

    const traced = createLangfuseCallback.mock.calls[0]?.[0]
    expect(traced.tags).toEqual(["dashboard", "tailored-resume"])
    expect(traced.traceMetadata.feature).toBe("tailored-resume")
    expect(calls[0]?.config.runName).toBe("tailored-resume")
  })

  it("records which page the run was started from", async () => {
    // Not derivable from the name: a letter and a resume are both generated
    // from /jobs, and criteria from /jobs/schedules.
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent } = fakeAgent("ok")

    await invokeTracedAgent(
      agent,
      run({ name: "search-criteria", route: "/jobs/schedules" })
    )

    expect(createLangfuseCallback.mock.calls[0]?.[0].traceMetadata.route).toBe(
      "/jobs/schedules"
    )
  })

  it("gives the handler and the metadata the same session, and a fresh one each run", async () => {
    // The handler retains run state, so one shared across invocations would mix
    // traces — and a metadata session that disagreed with the handler's would
    // file the run under a conversation it was not part of.
    createLangfuseCallback.mockReturnValue({ name: "langfuse" })
    const { agent, calls } = fakeAgent("ok")

    await invokeTracedAgent(agent, run())
    await invokeTracedAgent(agent, run())

    const sessions = calls.map(
      (call) => call.config.metadata?.langfuseSessionId
    )
    expect(sessions[0]).toBe(
      createLangfuseCallback.mock.calls[0]?.[0].sessionId
    )
    expect(sessions[1]).toBe(
      createLangfuseCallback.mock.calls[1]?.[0].sessionId
    )
    expect(sessions[0]).not.toBe(sessions[1])
    expect(createLangfuseCallback).toHaveBeenCalledTimes(2)
  })

  it("attributes the run to the session's user", async () => {
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent, calls } = fakeAgent("ok")

    await invokeTracedAgent(agent, run())

    expect(createLangfuseCallback.mock.calls[0]?.[0].userId).toBe(USER_ID)
    expect(calls[0]?.config.metadata?.langfuseUserId).toBe(USER_ID)
  })

  it("passes no callbacks at all when Langfuse is unconfigured", async () => {
    // ⚠️ `callbacks: [undefined]` is not the same as no callbacks — LangChain
    // walks the array. Without keys `createLangfuseCallback` returns undefined,
    // which is the ordinary state of a local checkout.
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent, calls } = fakeAgent("ok")

    await invokeTracedAgent(agent, run())

    expect(calls[0]?.config).not.toHaveProperty("callbacks")
  })

  it("passes the handler through when Langfuse is configured", async () => {
    const callback = { name: "langfuse" }
    createLangfuseCallback.mockReturnValue(callback)
    const { agent, calls } = fakeAgent("ok")

    await invokeTracedAgent(agent, run())

    expect(calls[0]?.config.callbacks).toEqual([callback])
  })

  it("refuses an empty answer rather than returning one", async () => {
    // Every caller would otherwise need this check: the letters would save an
    // empty object, and the criteria would propose a search for everything.
    createLangfuseCallback.mockReturnValue(undefined)
    const { agent } = fakeAgent("   \n  ")

    await expect(invokeTracedAgent(agent, run())).rejects.toThrow(
      /cover-letter agent returned an empty message/
    )
  })

  it("refuses an answer that is missing entirely", async () => {
    createLangfuseCallback.mockReturnValue(undefined)
    const agent = {
      async invoke() {
        return { messages: [] }
      },
    } as unknown as Agent

    await expect(invokeTracedAgent(agent, run())).rejects.toThrow(
      /empty message/
    )
  })
})
