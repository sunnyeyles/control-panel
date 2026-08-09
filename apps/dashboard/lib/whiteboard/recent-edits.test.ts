import { beforeEach, describe, expect, it } from "vitest"

import {
  clearRecentEdits,
  drainRecentEdits,
  noteAgentEdit,
  noteUserEdit,
} from "./recent-edits"

beforeEach(() => clearRecentEdits())

describe("attribution", () => {
  it("records what the user touched, as tldraw's own ids", () => {
    noteUserEdit("shape:s1")
    noteUserEdit("shape:s2")

    expect(drainRecentEdits()).toEqual(["shape:s1", "shape:s2"])
  })

  it("does not report a shape the agent drew as the user's work", () => {
    noteAgentEdit("shape:s1")
    noteUserEdit("shape:s1")

    expect(drainRecentEdits()).toEqual([])
  })

  it("gives the shape back to the user once the agent's write is accounted for", () => {
    noteAgentEdit("shape:s1")
    noteUserEdit("shape:s1")
    noteUserEdit("shape:s1")

    expect(drainRecentEdits()).toEqual(["shape:s1"])
  })

  it("leaves the user's other shapes alone while suppressing the agent's", () => {
    noteAgentEdit("shape:s1")
    noteUserEdit("shape:s1")
    noteUserEdit("shape:s2")

    expect(drainRecentEdits()).toEqual(["shape:s2"])
  })
})

describe("draining", () => {
  it("scopes 'recent' to one turn", () => {
    noteUserEdit("shape:s1")
    drainRecentEdits()

    expect(drainRecentEdits()).toEqual([])
  })

  it("drops a claim the store never answered, rather than carrying it over", () => {
    noteAgentEdit("shape:s1")
    drainRecentEdits()

    noteUserEdit("shape:s1")

    expect(drainRecentEdits()).toEqual(["shape:s1"])
  })

  it("forgets claims as well as edits when a saved board is loaded", () => {
    noteAgentEdit("shape:s1")
    clearRecentEdits()

    noteUserEdit("shape:s1")

    expect(drainRecentEdits()).toEqual(["shape:s1"])
  })
})
