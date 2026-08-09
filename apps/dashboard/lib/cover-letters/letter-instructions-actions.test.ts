import { readFile } from "node:fs/promises"

import type { CurrentUser } from "@/lib/auth/current-user"
import {
  fakeDocumentDb,
  mergeClients,
} from "@/lib/test-support/fake-document-db"
import {
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
} from "@workspace/agents/cover-letter"
import type { CoverLetterInstructions, PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { FakeResumes } from "@/lib/test-support/fake-resumes"
import {
  ANONYMOUS,
  OTHER_USER_ID,
  REFUSED,
  RESET_KEY,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import {
  createLetterInstructionsActions,
  DOCUMENT_NOT_FOUND,
} from "./letter-instructions-actions"

/**
 * The settings actions' authorization, bounds and ownership branches.
 *
 * Every claim these tickets make is about something invisible from the happy
 * path: that an unauthenticated POST is refused *before the body is read*, that
 * over-length text is refused rather than trimmed, that an over-cap example
 * does not leave a half-applied save behind, that an import cannot reach another
 * user's document, and that a document nobody can parse becomes a message
 * rather than a throw. The factory takes its dependencies through a
 * `createXActions(deps)` seam and imports nothing from Next precisely so all of
 * them are reachable here.
 *
 * The `@workspace/db` helpers are mocked — there is no database in this suite —
 * but the *document* side is real: `listDocuments`, `parseDocumentFile` and
 * `extractProfileText` all run, over the same PDF and DOCX fixtures
 * `profile-text.test.ts` uses. A fake extractor would only prove the action
 * calls one.
 */

const DOCUMENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const NOW = new Date("2026-08-04T00:00:00.000Z")

const INSTRUCTIONS = 'Never use the word "passionate". Sign off "Kind regards".'
const EXAMPLE = "Dear Hiring Team,\n\nI read the advertisement twice."

const mocks = vi.hoisted(() => ({
  coverLetterInstructions: vi.fn(),
  saveCoverLetterInstructions: vi.fn(),
}))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return {
    ...actual,
    coverLetterInstructions: mocks.coverLetterInstructions,
    saveCoverLetterInstructions: mocks.saveCoverLetterInstructions,
  }
})

/** Records every read and write of the settings row, and can fail either. */
class SpyDb {
  readonly saves: {
    userId: string
    instructions: string
    exampleLetter: string
  }[] = []
  readonly reads: string[] = []

  row: { instructions: string; exampleLetter: string } | undefined
  readError: unknown
  saveError: unknown

  seed(values: { instructions: string; exampleLetter: string }): this {
    this.row = values
    return this
  }

  asPrisma(): PrismaClient {
    // Nothing reaches a delegate — both helpers are mocked — so this only has
    // to be the value the action threads through to them.
    return {} as unknown as PrismaClient
  }

  installMocks(): void {
    mocks.coverLetterInstructions.mockImplementation(
      async (_prisma, userId: string) => {
        if (this.readError) throw this.readError
        this.reads.push(userId)

        return this.row
          ? ({ userId, ...this.row, updatedAt: NOW } as CoverLetterInstructions)
          : undefined
      }
    )

    mocks.saveCoverLetterInstructions.mockImplementation(
      async (
        _prisma,
        userId: string,
        values: { instructions: string; exampleLetter: string }
      ) => {
        if (this.saveError) throw this.saveError
        this.saves.push({ userId, ...values })
        this.row = values

        return { userId, ...values, updatedAt: NOW } as CoverLetterInstructions
      }
    )
  }
}

/** The same real PDF and DOCX `profile-text.test.ts` and the draft suite use. */
async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(
      new URL(`../candidate/__fixtures__/${name}`, import.meta.url)
    )
  )
}

let store: SpyDb
let resumes: FakeResumes

beforeEach(() => {
  store = new SpyDb()
  store.installMocks()
  resumes = new FakeResumes(EXAMPLE, NOW).add({
    resumeId: DOCUMENT_ID,
    extension: ".md",
    documentType: "cover-letter",
    originalFilename: "letter-acme.md",
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createLetterInstructionsActions({
    getUser: async () => user,
    // One client, because the action has one: the instructions row comes from
    // `store` and `documents` from the rows the fake store recorded.
    getPrisma: () =>
      mergeClients(store.asPrisma(), fakeDocumentDb(USER_ID, resumes.rows)),
    getResumes: () => resumes,
    newResetKey: () => RESET_KEY,
  })
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

/**
 * A `FormData` that records which fields were read.
 *
 * "Refused before the body is read" is otherwise unfalsifiable: an action that
 * parsed the body first and refused afterwards would satisfy every assertion
 * about what was written. Reading through a proxy makes the ordering itself
 * observable.
 */
function watchedForm(entries: Record<string, string>): {
  formData: FormData
  reads: string[]
} {
  const data = form(entries)
  const reads: string[] = []

  const formData = new Proxy(data, {
    get(target, property, receiver) {
      if (property === "get") {
        return (name: string) => {
          reads.push(name)
          return target.get(name)
        }
      }

      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as FormData

  return { formData, reads }
}

const saveForm = (overrides: Partial<Record<string, string>> = {}) =>
  form({ instructions: INSTRUCTIONS, exampleLetter: EXAMPLE, ...overrides })

const importForm = (file = `${DOCUMENT_ID}.md`) => form({ file })

describe("the gate", () => {
  it("refuses an anonymous caller before the body is read", async () => {
    const save = watchedForm({ instructions: "x", exampleLetter: "y" })
    const saved = await actionsFor(ANONYMOUS).saveLetterInstructions(
      IDLE,
      save.formData
    )

    const imported = watchedForm({ file: `${DOCUMENT_ID}.md` })
    const filled = await actionsFor(ANONYMOUS).importExampleLetter(
      IDLE,
      imported.formData
    )

    expect(saved).toEqual({ status: "error", message: NOT_AUTHORIZED })
    expect(filled).toEqual({ status: "error", message: NOT_AUTHORIZED })
    // Not merely refused: refused before a single field was looked at, and
    // before the database or the bucket was touched.
    expect(save.reads).toEqual([])
    expect(imported.reads).toEqual([])
    expect(store.saves).toHaveLength(0)
    expect(store.reads).toHaveLength(0)
  })

  it("gives a refused caller the identical state an anonymous one gets", async () => {
    // Identical wording on purpose: telling this caller apart from the
    // anonymous one confirms their account exists and is merely not on the
    // allowlist, which is more than they need to know.
    const anonymous = await actionsFor(ANONYMOUS).saveLetterInstructions(
      IDLE,
      saveForm()
    )
    const refused = await actionsFor(REFUSED).saveLetterInstructions(
      IDLE,
      saveForm()
    )

    expect(refused).toEqual(anonymous)
    expect(refused).toMatchObject({ message: NOT_AUTHORIZED })
    expect(store.saves).toHaveLength(0)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    const actions = createLetterInstructionsActions({
      getUser: async () => {
        throw new Error("neon is asleep")
      },
      getPrisma: () =>
        mergeClients(store.asPrisma(), fakeDocumentDb(USER_ID, resumes.rows)),
      getResumes: () => resumes,
    })

    const saved = await actions.saveLetterInstructions(IDLE, saveForm())
    const filled = await actions.importExampleLetter(IDLE, importForm())

    expect(saved).toEqual({ status: "error", message: NOT_AUTHORIZED })
    expect(filled).toEqual({ status: "error", message: NOT_AUTHORIZED })
    expect(store.saves).toHaveLength(0)
  })
})

describe("saveLetterInstructions", () => {
  it("persists both fields against the session's user", async () => {
    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      saveForm()
    )

    expect(result).toEqual({
      status: "success",
      message: expect.any(String),
      resetKey: RESET_KEY,
    })
    expect(store.saves).toEqual([
      {
        userId: USER_ID,
        instructions: INSTRUCTIONS,
        exampleLetter: EXAMPLE,
      },
    ])
  })

  it("takes the userId from the session, never from the form", async () => {
    await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      saveForm({ userId: OTHER_USER_ID })
    )

    expect(store.saves[0]?.userId).toBe(USER_ID)
  })

  it("accepts two empty fields, which is how the setting is cleared", async () => {
    // An empty textarea posts `""`, and clearing both must be an ordinary save
    // rather than a refusal — it is how a user goes back to the built-in
    // behaviour.
    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      form({ instructions: "", exampleLetter: "" })
    )

    expect(result.status).toBe("success")
    expect(store.saves).toEqual([
      { userId: USER_ID, instructions: "", exampleLetter: "" },
    ])
  })

  it("trims the edges, so a stray newline is not what stores a value", async () => {
    await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      form({ instructions: `  ${INSTRUCTIONS}\n\n`, exampleLetter: "   " })
    )

    expect(store.saves).toEqual([
      { userId: USER_ID, instructions: INSTRUCTIONS, exampleLetter: "" },
    ])
  })

  it("refuses over-cap instructions, naming the count and the limit", async () => {
    const tooLong = "x".repeat(MAX_INSTRUCTIONS_CHARS + 431)

    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      saveForm({ instructions: tooLong })
    )

    expect(result.status).toBe("error")

    const message = result.status === "error" ? result.message : ""
    // Both numbers, because a refusal that says only "too long" leaves the user
    // deleting text at random until it is accepted.
    expect(message).toContain(String(MAX_INSTRUCTIONS_CHARS + 431))
    expect(message).toContain(String(MAX_INSTRUCTIONS_CHARS))
    // ⚠️ And nothing was trimmed to fit: a silently shortened rule list would
    // save fine and then be quietly disobeyed from its cut-off point on.
    expect(store.saves).toHaveLength(0)
  })

  it("refuses an over-cap example without persisting the valid instructions", async () => {
    // ⚠️ Both fields save together, so validating one and writing it before
    // discovering the other is over its cap would leave a half-applied save
    // behind a message saying nothing had been saved at all.
    const tooLong = "y".repeat(MAX_EXAMPLE_LETTER_CHARS + 104)

    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      saveForm({ exampleLetter: tooLong })
    )

    expect(result.status).toBe("error")

    const message = result.status === "error" ? result.message : ""
    expect(message).toContain(String(MAX_EXAMPLE_LETTER_CHARS + 104))
    expect(message).toContain(String(MAX_EXAMPLE_LETTER_CHARS))
    expect(store.saves).toHaveLength(0)
  })

  it("refuses a body missing a field rather than clearing it", async () => {
    // Reachable only by posting directly — the section always submits both
    // textareas. Defaulting the absent one to `""` would make a partial POST a
    // way to wipe a field the user never touched.
    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      form({ instructions: INSTRUCTIONS })
    )

    expect(result.status).toBe("error")
    expect(store.saves).toHaveLength(0)
  })

  it("turns a store failure into an error state, not a throw", async () => {
    store.saveError = new Error("connection reset")

    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      IDLE,
      saveForm()
    )

    expect(result.status).toBe("error")
  })
})

describe("importExampleLetter", () => {
  it("extracts a .md document and stores its text as the example", async () => {
    store.seed({ instructions: INSTRUCTIONS, exampleLetter: "" })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm()
    )

    expect(result.status).toBe("success")
    // Names the document, because the picker offers several and the box it
    // fills is above the button.
    expect(result.status === "success" && result.message).toContain(
      "letter-acme.md"
    )
    expect(store.saves).toEqual([
      {
        userId: USER_ID,
        // ⚠️ Carried through unchanged. A save writes both fields, so an import
        // that did not read the current row first would delete the user's rules
        // as a side effect of filling a different box.
        instructions: INSTRUCTIONS,
        exampleLetter: EXAMPLE,
      },
    ])
  })

  it("leaves the instructions empty for a user who has no row yet", async () => {
    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm()
    )

    expect(result.status).toBe("success")
    expect(store.saves[0]?.instructions).toBe("")
  })

  it("imports a real PDF", async () => {
    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".pdf",
      documentType: "cover-letter",
      originalFilename: "letter-acme.pdf",
      bytes: await fixtureBytes("alice-cv.pdf"),
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.pdf`)
    )

    expect(result.status).toBe("success")
    // Extracted, not merely fetched.
    expect(store.saves[0]?.exampleLetter).toContain(
      "monolith to a set of services at Contoso"
    )
  })

  it("imports a real DOCX", async () => {
    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".docx",
      documentType: "cover-letter",
      originalFilename: "letter-acme.docx",
      bytes: await fixtureBytes("alice-cv.docx"),
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.docx`)
    )

    expect(result.status).toBe("success")
    expect(store.saves[0]?.exampleLetter).toContain(
      "monolith to a set of services at Contoso"
    )
  })

  it("refuses another user's document in the same words as a missing one", async () => {
    // ⚠️ One message for both, or a picker that takes a uuid becomes an oracle
    // for whether another user's document is real.
    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".md",
      userId: OTHER_USER_ID,
      documentType: "cover-letter",
      originalFilename: "someone-elses-letter.md",
    })

    const notMine = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm()
    )

    resumes = new FakeResumes(EXAMPLE, NOW)

    const missing = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm()
    )

    expect(notMine).toEqual(missing)
    expect(notMine).toEqual({ status: "error", message: DOCUMENT_NOT_FOUND })
    // And the refusal did not name the file it declined to read.
    expect(notMine).not.toMatchObject({
      message: expect.stringContaining("someone-elses-letter"),
    })
    expect(store.saves).toHaveLength(0)
  })

  it("refuses a malformed file reference before the store is listed", async () => {
    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm("../../etc/passwd")
    )

    expect(result).toEqual({ status: "error", message: DOCUMENT_NOT_FOUND })
    expect(store.saves).toHaveLength(0)
  })

  it("refuses a format nothing can read, by name", async () => {
    // `resumes` accepts `.doc`, `.odt` and `.rtf` on upload and still has no
    // parser for them, so the user is being refused a document this app already
    // took — without the extension in the sentence that reads as a bug.
    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".rtf",
      documentType: "cover-letter",
      originalFilename: "letter-acme.rtf",
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.rtf`)
    )

    expect(result.status).toBe("error")

    const message = result.status === "error" ? result.message : ""
    expect(message).toContain(".rtf")
    expect(message).toContain("letter-acme.rtf")
    expect(store.saves).toHaveLength(0)
  })

  it("turns a ProfileTextError into a message naming the document, never a throw", async () => {
    const whole = await fixtureBytes("alice-cv.pdf")

    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".pdf",
      documentType: "cover-letter",
      originalFilename: "letter-acme.pdf",
      bytes: whole.slice(0, Math.floor(whole.length / 2)),
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.pdf`)
    )

    expect(result.status).toBe("error")
    expect(result.status === "error" && result.message).toContain(
      "letter-acme.pdf"
    )
    // Neither a crash nor an empty field silently saved over the user's own.
    expect(store.saves).toHaveLength(0)
  })

  it("refuses a document with no text in it rather than clearing the field", async () => {
    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".txt",
      documentType: "cover-letter",
      originalFilename: "empty.txt",
      bytes: new TextEncoder().encode("   \n\n  "),
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.txt`)
    )

    expect(result.status).toBe("error")
    expect(result.status === "error" && result.message).toContain("empty.txt")
    expect(store.saves).toHaveLength(0)
  })

  it("refuses extracted text over the cap, naming the document and both numbers", async () => {
    const overCap = "z".repeat(MAX_EXAMPLE_LETTER_CHARS + 12)

    resumes = new FakeResumes(EXAMPLE, NOW).add({
      resumeId: DOCUMENT_ID,
      extension: ".txt",
      documentType: "cover-letter",
      originalFilename: "very-long-letter.txt",
      bytes: new TextEncoder().encode(overCap),
    })

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm(`${DOCUMENT_ID}.txt`)
    )

    expect(result.status).toBe("error")

    const message = result.status === "error" ? result.message : ""
    expect(message).toContain("very-long-letter.txt")
    expect(message).toContain(String(MAX_EXAMPLE_LETTER_CHARS + 12))
    expect(message).toContain(String(MAX_EXAMPLE_LETTER_CHARS))
    // Refused rather than trimmed, for the same reason a CV is.
    expect(store.saves).toHaveLength(0)
  })

  it("does not write when the current row cannot be read", async () => {
    // The read is what carries the instructions through. Writing anyway would
    // replace them with an empty string on the way to filling a different box.
    store.readError = new Error("neon is asleep")

    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm()
    )

    expect(result.status).toBe("error")
    expect(store.saves).toHaveLength(0)
  })
})

describe("the reset key", () => {
  it("carries the previous reset key forward on failure", async () => {
    const previous: ActionState = {
      status: "success",
      message: "Saved.",
      resetKey: RESET_KEY,
    }

    const result = await actionsFor(SIGNED_IN).saveLetterInstructions(
      previous,
      saveForm({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) })
    )

    expect(result).toEqual({
      status: "error",
      message: expect.any(String),
      resetKey: RESET_KEY,
    })
  })

  it("omits the reset key when nothing has succeeded yet", async () => {
    const result = await actionsFor(SIGNED_IN).importExampleLetter(
      IDLE,
      importForm("not-a-document")
    )

    expect(result).not.toHaveProperty("resetKey")
  })
})
