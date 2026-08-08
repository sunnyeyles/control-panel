import { afterEach, describe, expect, it, vi } from "vitest"

import { timed } from "./timed"

afterEach(() => {
  vi.restoreAllMocks()
})

function captureLogs() {
  const lines: string[] = []
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line))
  })
  return lines
}

describe("timed", () => {
  it("returns what the work returned", async () => {
    captureLogs()

    await expect(timed("postings", async () => ["a", "b"])).resolves.toEqual([
      "a",
      "b",
    ])
  })

  it("logs one greppable line naming the label", async () => {
    const lines = captureLogs()

    await timed("briefings.postings", async () => null)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^timing briefings\.postings \d+ms resolved$/)
  })

  /**
   * ⚠️ **A rejection is timed and re-thrown, never swallowed.** A load that
   * failed after eight seconds and one that failed instantly are different
   * problems, and the caller's own `try`/`catch` still decides what the user
   * sees — `PostingsSection` in `app/(app)/jobs/page.tsx` renders its
   * degraded alert from exactly that catch.
   */
  it("times a rejection and re-throws it unchanged", async () => {
    const lines = captureLogs()
    const failure = new Error("connection reset")

    await expect(
      timed("briefings.postings", async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(lines[0]).toMatch(/^timing briefings\.postings \d+ms threw$/)
  })

  /**
   * ⚠️ **`threw`, not `failed`, and the wording is the test.** `redirect()` in
   * a server component signals itself by throwing, so the gate sending an
   * anonymous visitor to sign-in arrives here as a rejection. Calling that a
   * failure would put a line in the production log claiming something went
   * wrong every time somebody signed out.
   */
  it("does not call a rejection a failure", async () => {
    const lines = captureLogs()

    await expect(
      timed("briefings.gate", async () => {
        throw new Error("NEXT_REDIRECT")
      })
    ).rejects.toThrow()

    expect(lines[0]).not.toMatch(/fail/i)
  })

  it("says nothing at error level, so a timing is not a second incident", async () => {
    captureLogs()
    const errored = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(
      timed("briefings.postings", async () => {
        throw new Error("connection reset")
      })
    ).rejects.toThrow()

    expect(errored).not.toHaveBeenCalled()
  })
})
