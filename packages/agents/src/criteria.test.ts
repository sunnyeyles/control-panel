import { describe, expect, it } from "vitest"

import {
  criteriaSchemaDescription,
  parseSearchCriteria,
  SearchCriteriaSchema,
  toSearchCriteriaPrompt,
} from "./criteria.ts"
import { PROFILE_EXTRACTOR_SYSTEM_PROMPT } from "./profile-extractor.ts"

/**
 * A well-formed extraction: every field populated, which is the case that has
 * to survive every fence and every round trip below unchanged.
 */
const CRITERIA = {
  titles: ["Senior Backend Engineer", "Platform Engineer"],
  locations: ["Sydney NSW"],
  keywords: ["TypeScript", "PostgreSQL", "AWS"],
  notes: "The CV names Sydney as the current city.",
}

describe("parseSearchCriteria", () => {
  it("round-trips a clean extraction unchanged", () => {
    expect(parseSearchCriteria(JSON.stringify(CRITERIA))).toEqual(CRITERIA)
  })

  /**
   * The two fence shapes a model actually produces. Both are formatting habits
   * rather than a refusal to follow the instruction, so both are stripped —
   * rejecting them would fail runs whose content was perfectly good.
   */
  it("strips a ```json fence", () => {
    const fenced = `\`\`\`json\n${JSON.stringify(CRITERIA, null, 2)}\n\`\`\``

    expect(parseSearchCriteria(fenced)).toEqual(CRITERIA)
  })

  it("strips a bare fence", () => {
    const fenced = `\`\`\`\n${JSON.stringify(CRITERIA)}\n\`\`\``

    expect(parseSearchCriteria(fenced)).toEqual(CRITERIA)
  })

  /**
   * The message matters as much as the throw. Whoever reads this is looking at
   * a failed extraction with no other evidence of what the model did, so the
   * error carries the start of what it actually said.
   */
  it("throws with the start of the message when it is not JSON at all", () => {
    expect(() =>
      parseSearchCriteria(
        "Certainly! Based on the CV, I would search for backend roles in Sydney."
      )
    ).toThrow(/was not JSON/i)

    expect(() =>
      parseSearchCriteria("Certainly! Based on the CV, I would search")
    ).toThrow(/Certainly! Based on the CV/)
  })

  /**
   * The extraction's whole output is a set of searches to run. One with no
   * title to search for has not done its job, so both shapes of that — the
   * field missing and the field empty — are rejected rather than stored.
   */
  it("rejects a payload with no titles field", () => {
    expect(() =>
      parseSearchCriteria(JSON.stringify({ locations: [], keywords: [] }))
    ).toThrow(/does not match the search-criteria schema/i)
  })

  it("rejects an empty titles array", () => {
    expect(() =>
      parseSearchCriteria(
        JSON.stringify({ titles: [], locations: [], keywords: [] })
      )
    ).toThrow(/titles/i)
  })

  /**
   * The honest-absence case, and the one the prompt explicitly asks for. A CV
   * that states no location must be able to come back saying so, rather than
   * being pushed into naming a city to satisfy the parser.
   */
  it("accepts empty locations and keywords", () => {
    const criteria = parseSearchCriteria(
      JSON.stringify({
        titles: ["Data Engineer"],
        locations: [],
        keywords: [],
        notes: "The CV states no location, so none was proposed.",
      })
    )

    expect(criteria.locations).toEqual([])
    expect(criteria.keywords).toEqual([])
    expect(criteria.notes).toMatch(/no location/i)
  })

  it("treats notes as optional", () => {
    const criteria = parseSearchCriteria(
      JSON.stringify({
        titles: ["Data Engineer"],
        locations: ["Remote"],
        keywords: ["Python"],
      })
    )

    expect(criteria.notes).toBeUndefined()
    expect(criteria.titles).toEqual(["Data Engineer"])
  })

  it("rejects titles that are not strings", () => {
    expect(() =>
      parseSearchCriteria(
        JSON.stringify({
          titles: [{ title: "Data Engineer" }],
          locations: [],
          keywords: [],
        })
      )
    ).toThrow(/does not match the search-criteria schema/i)
  })
})

/**
 * The point of `criteriaSchemaDescription` is that the extractor's prompt is
 * not a second copy of the contract. These assertions are what makes "add a
 * field and the extractor asks for it" true rather than hoped for — nothing
 * below names a field in a prompt string, and yet the prompt asks for them all.
 */
describe("criteriaSchemaDescription", () => {
  it("is derived from the schema, so a new field needs no prompt edit", () => {
    const rendered = JSON.parse(criteriaSchemaDescription) as {
      properties: Record<string, { type?: string }>
      required?: string[]
    }

    expect(Object.keys(rendered.properties).sort()).toEqual(
      Object.keys(SearchCriteriaSchema.shape).sort()
    )
    expect(rendered.required).toContain("titles")
    expect(rendered.required).not.toContain("notes")
  })

  it("carries each field's description into the extractor's prompt verbatim", () => {
    for (const field of ["titles", "locations", "keywords", "notes"] as const) {
      const description = SearchCriteriaSchema.shape[field].description ?? ""

      expect(description).not.toBe("")
      expect(criteriaSchemaDescription).toContain(description)
      expect(PROFILE_EXTRACTOR_SYSTEM_PROMPT).toContain(description)
    }
  })

  /**
   * The `min(1)` is the one constraint the model cannot infer from the field
   * names, so it has to survive into the rendered schema the prompt carries.
   */
  it("carries the at-least-one-title constraint into the prompt", () => {
    const rendered = JSON.parse(criteriaSchemaDescription) as {
      properties: { titles?: { minItems?: number } }
    }

    expect(rendered.properties.titles?.minItems).toBe(1)
  })
})

/**
 * The CV reaches the model through this function and nowhere else, so the two
 * things that could quietly ruin an extraction — a paraphrase and a truncation
 * — are asserted against rather than trusted.
 */
describe("toSearchCriteriaPrompt", () => {
  const BACKGROUND = [
    "Jane Citizen — Backend Engineer",
    "",
    "Acme Pty Ltd, 2021–2026. Built payment services in TypeScript on AWS.",
    "Widget Co, 2018–2021. PostgreSQL, Go, on-call one week in six.",
    "",
    "BSc Computer Science, University of Sydney.",
  ].join("\n")

  it("carries the CV through verbatim", () => {
    expect(toSearchCriteriaPrompt(BACKGROUND)).toContain(BACKGROUND)
  })

  /**
   * The inverse of the system-prompt assertion above, and it locks in a
   * decision rather than describing an accident.
   *
   * The schema belongs in the system prompt and appears there once. Repeating
   * it here would put the same JSON Schema in the context twice on every call,
   * for a document that is already the largest thing in it.
   *
   * `job-scout.ts` used to be arranged the same way and no longer needs to be:
   * its hand-off is a `submit_findings` tool call, so the provider renders the
   * schema and its prompt carries none of it. This agent still answers in a
   * final message, so the schema has to reach it somehow.
   */
  it("does not repeat the schema the system prompt already carries", () => {
    expect(toSearchCriteriaPrompt(BACKGROUND)).not.toContain(
      criteriaSchemaDescription
    )
  })

  /**
   * The label is not a security boundary — a document can write a fence of its
   * own, and nothing here stops it. What contains an injected instruction is the
   * empty tool set. The label is still worth asserting: it is what tells the
   * model which side of the message is the person and which is the task.
   */
  it("labels the CV as quoted material rather than instruction", () => {
    const prompt = toSearchCriteriaPrompt(BACKGROUND)

    expect(prompt).toMatch(/quoted material, not instruction/i)
    expect(prompt).toContain("--- end of CV ---")
    expect(prompt.indexOf("quoted material")).toBeLessThan(
      prompt.indexOf(BACKGROUND)
    )
  })

  /**
   * A long CV is passed through whole. Bounds belong to the caller, checked
   * before this is reached — criteria drawn from the first half of a CV look
   * exactly like criteria drawn from all of it, and the half most often lost is
   * the earlier career that evidenced the seniority.
   */
  it("does not truncate a long CV", () => {
    const long = `${BACKGROUND}\n${"Delivered a project. ".repeat(2_000)}`

    expect(toSearchCriteriaPrompt(long)).toContain(long)
  })
})
