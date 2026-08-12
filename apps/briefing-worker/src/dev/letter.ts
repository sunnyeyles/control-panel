import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, resolve } from "node:path"
import { parseArgs } from "node:util"

import { HumanMessage } from "@langchain/core/messages"
import {
  assertDraftable,
  CoverLetterRequestSchema,
  createCoverLetterWriter,
  parseFindings,
  postingId,
  toCoverLetterPrompt,
  UndraftableError,
  type CoverLetterRequest,
  type Findings,
  type Posting,
} from "@workspace/agents"

/**
 * Draft one cover letter, from real data, onto disk.
 *
 * This answers one question before anything is built around it: is a letter
 * written from a search-result teaser plus the candidate's own CV worth the
 * surface it would need? No S3, no database, no migration, no dashboard — a
 * Findings file, a document the candidate wrote, one model call, one file out.
 *
 * The Findings file is the one `watch` writes beside the brief, so the input is
 * a real scout's output; `fixtures/` holds one transcribed from a live SEEK
 * advertisement. Under `dev/`, so `build.mjs` (entry `src/index.ts`) cannot
 * ship it.
 */

const USAGE = `
Draft a cover letter for one Posting.

  pnpm --filter=@workspace/briefing-worker letter \\
    --findings ./.briefings/dev/<user>/briefs/2026/08/03/<run>.json \\
    --profile ./cv.md \\
    --posting 1

  --findings <path>  A Findings JSON file — what \`watch\` writes beside the
                     brief, or fixtures/example-findings.json.
  --profile <path>   The candidate's own words, as .md or .txt. Nothing here
                     reads a PDF; the dashboard does.
  --posting <sel>    Which Posting: a 1-based number from --list, a posting id,
                     or a distinctive substring of the title, company or URL.
  --name <name>      The candidate's name, if the letter should use it. Left
                     out, the letter carries a placeholder rather than a guess.
  --out <dir>        Where the letter lands. Default ./.letters
  --list             Print the Postings in the file and stop.
  --quiet            Write the letter without printing it.
  --help

The letter is the deliverable, so it is printed as well as written. One model
call, no tools, no network beyond the model: OPENAI_API_KEY must be set.
`

/**
 * The formats a profile may arrive in.
 *
 * Narrower than the app's, deliberately. The dashboard reads a PDF and a DOCX
 * since #86, through `apps/dashboard/lib/candidate/profile-text.ts`; this is
 * a dev harness under `dev/` that exists to make one model call from a file on
 * disk, and adding `unpdf` and `mammoth` to the worker to save a `--profile`
 * flag pointing at a `.md` is not a trade worth making. Anyone who wants a
 * letter from a PDF has the app.
 */
const PROFILE_EXTENSIONS = new Set([".md", ".txt"])

interface Options {
  findings: string
  profile?: string
  posting?: string
  name?: string
  out: string
  list: boolean
  quiet: boolean
}

function readOptions(): Options | undefined {
  const { values } = parseArgs({
    options: {
      findings: { type: "string" },
      profile: { type: "string" },
      posting: { type: "string" },
      name: { type: "string" },
      out: { type: "string", default: ".letters" },
      list: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return undefined
  }

  if (!values.findings) {
    throw new Error("Pass --findings <file.json>. See --help.")
  }

  return {
    findings: values.findings,
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.posting ? { posting: values.posting } : {}),
    ...(values.name ? { name: values.name } : {}),
    out: values.out ?? ".letters",
    list: values.list ?? false,
    quiet: values.quiet ?? false,
  }
}

/**
 * Fail before spending anything — the same rule `watch` follows, for the same
 * reason.
 */
function requireEnv(...names: string[]): void {
  const missing = names.filter((name) => !process.env[name])

  if (missing.length > 0) {
    throw new Error(
      `${missing.join(" and ")} must be set — this makes a real model call.`
    )
  }
}

/**
 * Validated on the way in, with `parseFindings` rather than a bare
 * `JSON.parse`.
 *
 * The same function the worker uses on the scout's hand-off, so a file this
 * accepts is a file the pipeline would have accepted — including the rule that
 * every posting carries a URL that parses. A hand-edited file that drifted from
 * the contract fails here rather than three steps later.
 */
async function readFindings(path: string): Promise<Findings> {
  const full = resolve(path)
  const raw = await readFile(full, "utf8").catch(() => {
    throw new Error(`No findings file at ${full}.`)
  })

  return parseFindings(raw)
}

/**
 * The candidate's own words, verbatim.
 *
 * Restricted to `.md` and `.txt` on purpose — see {@link PROFILE_EXTENSIONS}.
 * The parser dependency lives in the dashboard, which is where the feature is.
 */
async function readProfile(path: string): Promise<string> {
  const full = resolve(path)
  const extension = extname(full).toLowerCase()

  if (!PROFILE_EXTENSIONS.has(extension)) {
    throw new Error(
      `${full} is ${extension || "extensionless"}; only ${[...PROFILE_EXTENSIONS].join(" and ")} are read. A PDF needs a text extractor this does not have.`
    )
  }

  return readFile(full, "utf8").catch(() => {
    throw new Error(`No profile file at ${full}.`)
  })
}

/**
 * Which Posting the letter is for.
 *
 * Three ways to say it, because all three are things a person actually has to
 * hand: the number `--list` printed, the id a stored letter would be keyed by,
 * or a piece of the title. A substring that matches more than one Posting is
 * refused rather than resolved to the first — picking silently is how the
 * letter ends up addressed to the wrong company.
 */
function selectPosting(findings: Findings, selector: string): Posting {
  const { postings } = findings

  if (postings.length === 0) {
    throw new Error(
      "The findings carry no postings, so there is nothing to write about. An empty result is a legitimate one — try another run."
    )
  }

  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1
    const posting = postings[index]

    if (!posting) {
      throw new Error(
        `--posting ${selector} is out of range; the file holds ${postings.length}. Use --list.`
      )
    }

    return posting
  }

  const byId = postings.find((posting) => postingId(posting) === selector)
  if (byId) return byId

  const needle = selector.toLowerCase()
  const matches = postings.filter((posting) =>
    [posting.title, posting.company, posting.url].some((field) =>
      field.toLowerCase().includes(needle)
    )
  )

  if (matches.length === 1 && matches[0]) return matches[0]

  if (matches.length > 1) {
    throw new Error(
      `--posting ${selector} matches ${matches.length} postings. Narrow it, or use the number from --list.`
    )
  }

  throw new Error(
    `--posting ${selector} matches nothing in the file. Use --list to see what is there.`
  )
}

function printPostings(findings: Findings): void {
  const lines = findings.postings.map((posting, index) =>
    [
      `${index + 1}. ${posting.title} — ${posting.company}`,
      `   ${posting.location}`,
      `   ${posting.url}`,
      `   id ${postingId(posting)}`,
    ].join("\n")
  )

  process.stdout.write(
    `${lines.join("\n\n") || "No postings in this file."}\n\n`
  )
}

/**
 * One model call.
 *
 * `.invoke()` rather than the `.stream()` machinery `run-agent.ts` uses: with
 * no tools the graph is START → model → END, so there are no intermediate
 * steps for a transcript to be interesting about.
 */
async function draft(request: CoverLetterRequest): Promise<string> {
  const writer = createCoverLetterWriter()

  const result = await writer.invoke({
    messages: [new HumanMessage(toCoverLetterPrompt(request))],
  })

  const letter = result.messages.at(-1)?.text.trim() ?? ""
  if (letter.length === 0) {
    throw new Error("The writer returned an empty letter.")
  }

  return letter
}

async function main(): Promise<void> {
  const options = readOptions()
  if (!options) return

  const findings = await readFindings(options.findings)

  if (options.list || !options.posting) {
    printPostings(findings)
    if (!options.list) {
      throw new Error("Pass --posting <number|id|substring>. See --help.")
    }
    return
  }

  if (!options.profile) {
    throw new Error("Pass --profile <file.md|file.txt>. See --help.")
  }

  const posting = selectPosting(findings, options.posting)
  const background = await readProfile(options.profile)

  // Before the key check and before the model call, so an unusable profile
  // costs nothing. A letter written from too little is not a thin letter, it
  // is a fabricated one.
  assertDraftable({ background })
  requireEnv("OPENAI_API_KEY")

  const request = CoverLetterRequestSchema.parse({
    posting,
    profile: { ...(options.name ? { name: options.name } : {}), background },
  })

  const letter = await draft(request)
  const path = resolve(options.out, `${postingId(posting)}.md`)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${letter}\n`, "utf8")

  if (!options.quiet) process.stdout.write(`\n${letter}\n`)

  process.stdout.write(
    [
      "",
      `  posting  ${posting.title} — ${posting.company}`,
      `  url      ${posting.url}`,
      `  words    ${letter.split(/\s+/).filter(Boolean).length}`,
      `  letter   ${path}`,
      "",
      "",
    ].join("\n")
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  // An undraftable profile is an expected answer, not a crash: it is the check
  // refusing before the model was called, which is what it is for.
  const prefix = error instanceof UndraftableError ? "Not draftable" : "Failed"

  process.stderr.write(`\n${prefix}: ${message}\n\n`)
  process.exitCode = 1
})
