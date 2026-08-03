import { randomUUID } from "node:crypto"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { createPrismaClient } from "@workspace/db"
import type { ClaimedSlot, DueJob, JobConfig } from "@workspace/db"
import { createBriefStore } from "@workspace/user-storage"

import { runBriefing } from "../run-briefing.ts"
import type { TraceEvent, TraceSink } from "../trace.ts"
import { createTerminalRenderer } from "./render.ts"
import {
  createDirectoryObjectStore,
  dryRunRecordArtifact,
  dryRunRecordFindings,
} from "./stores.ts"

/**
 * Watch one briefing run happen.
 *
 * The point of this file is what it does *not* do. The hourly tick claims a
 * slot, and a claim is at-most-once by design — so running the real handler to
 * see what a job does consumes that job's occurrence, writes a real object, and
 * spends real money. Debugging should not cost the thing being debugged.
 *
 * So this drives `runBriefing` directly: no claim, no `runs` row, no `next_run_at`
 * advance, no S3, no AWS credentials. The model and the search API are real,
 * because they are the parts worth watching; everything else is local.
 *
 * Run it with `tsx`, which is why there is no build step and no bundle. Nothing
 * here reaches `dist/` — the esbuild entry point is `src/index.ts` alone, so
 * the deployed zip cannot contain this file even by accident.
 */

/** Stable, so repeated runs land in the same directory rather than scattering. */
const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001"

const USAGE = `
Watch one briefing run, step by step.

  pnpm --filter=@workspace/briefing-worker watch --config <file.json>
  pnpm --filter=@workspace/briefing-worker watch --job <uuid>

  --config <path>   Search criteria to run, as a jobs.config JSON payload.
                    Needs no database.
  --job <uuid>      Take the criteria from a real job row. Read-only: the row
                    is not claimed, its schedule is not advanced, and no run
                    row is created. Needs DATABASE_URL.

  --out <dir>       Where the brief and the trace land. Default ./.briefings
  --at <iso>        The slot to run for, which decides the key's partition day.
                    Default now.
  --json            Print the raw trace as JSON lines instead of rendering it.
  --verbose         Do not truncate messages or tool results.
  --no-color        Plain text. Already the default when stdout is not a
                    terminal, or when NO_COLOR is set.
  --help

Always a dry run. The brief is written to --out, never to S3, and no artifacts
row is recorded. OPENAI_API_KEY and APIFY_TOKEN must be set; the model and
the SEEK search are real.
`

interface Options {
  config?: string
  job?: string
  out: string
  at?: string
  json: boolean
  verbose: boolean
  /**
   * Set only by `--no-color`. Left undefined otherwise so the renderer's own
   * answer — a terminal, and no `NO_COLOR` — is the one that applies; a flag
   * that always has a value would make piped output colourful.
   */
  color?: boolean
}

function readOptions(): Options | undefined {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      job: { type: "string" },
      out: { type: "string", default: ".briefings" },
      at: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return undefined
  }

  if (Boolean(values.config) === Boolean(values.job)) {
    throw new Error(
      "Pass exactly one of --config <file.json> or --job <uuid>. See --help."
    )
  }

  return {
    ...(values.config ? { config: values.config } : {}),
    ...(values.job ? { job: values.job } : {}),
    out: values.out ?? ".briefings",
    ...(values.at ? { at: values.at } : {}),
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    ...(values["no-color"] ? { color: false } : {}),
  }
}

/**
 * Fail before spending anything.
 *
 * A run that dies on a missing key after two successful searches has already
 * cost money and told you nothing you could not have known up front.
 */
function requireEnv(...names: string[]): void {
  const missing = names.filter((name) => !process.env[name])

  if (missing.length > 0) {
    throw new Error(
      `${missing.join(" and ")} must be set — the harness uses the real model and the real search API. Export them, or source the values the Lambda would fetch.`
    )
  }
}

/**
 * The job to run, from a file or from a row.
 *
 * Either way what comes back is a `DueJob`, so `runBriefing` cannot tell which
 * it got. That is deliberate: the harness must exercise the same path the tick
 * does, or it is watching something other than the thing that runs in
 * production.
 */
async function resolveJob(options: Options): Promise<DueJob> {
  const scheduledFor = readSlot(options.at)

  if (options.config) {
    const path = resolve(options.config)
    const raw = await readFile(path, "utf8").catch(() => {
      throw new Error(`No search criteria file at ${path}.`)
    })

    let config: JobConfig
    try {
      config = JSON.parse(raw) as JobConfig
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return {
      id: randomUUID(),
      userId: LOCAL_USER_ID,
      name: `local: ${options.config}`,
      config,
      scheduleCron: "0 9 * * *",
      scheduleTimezone: "UTC",
      nextRunAt: scheduledFor,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DueJob
  }

  requireEnv("DATABASE_URL")
  const prisma = createPrismaClient()

  try {
    const job = await prisma.job.findUnique({
      where: { id: options.job ?? "" },
    })
    if (!job) throw new Error(`No job with id ${options.job}.`)

    // Read-only, and the job's own `next_run_at` is deliberately ignored: the
    // harness runs the slot you asked for, not the one the tick would claim.
    return { ...job, nextRunAt: scheduledFor }
  } finally {
    await prisma.$disconnect()
  }
}

function readSlot(at: string | undefined): Date {
  if (!at) return new Date()

  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--at ${at} is not a date this can read. Try an ISO 8601 instant.`
    )
  }

  return parsed
}

/**
 * Two sinks in one: what a person watches, and what stays on disk.
 *
 * The file is written whatever happens, including on a failed run — a failure's
 * transcript is the one most worth keeping, and it is exactly what the
 * production report reduces to a single sentence.
 *
 * A stream rather than repeated `appendFile` calls, and that is not a
 * performance choice. A sink is synchronous by contract, so an appended write
 * can only be fired and not awaited — and concurrent appends to one file land
 * in whatever order the syscalls complete, which shuffles the transcript. A
 * write stream preserves order, which is the one property a transcript has.
 */
function createSink(options: Options, traceFile: WriteStream): TraceSink {
  const rendered = createTerminalRenderer({
    verbose: options.verbose,
    color: options.color,
  })

  return (event: TraceEvent) => {
    const json = JSON.stringify(event)

    if (options.json) {
      process.stdout.write(`${json}\n`)
    } else {
      rendered(event)
    }

    traceFile.write(`${json}\n`)
  }
}

async function main(): Promise<void> {
  const options = readOptions()
  if (!options) return

  requireEnv("OPENAI_API_KEY", "APIFY_TOKEN")

  const job = await resolveJob(options)
  const slot: ClaimedSlot = {
    runId: randomUUID(),
    scheduledFor: job.nextRunAt,
    nextRunAt: job.nextRunAt,
  }

  const out = resolve(options.out)
  const tracePath = join(out, "traces", `${slot.runId}.jsonl`)
  await mkdir(dirname(tracePath), { recursive: true })

  const objects = createDirectoryObjectStore({ directory: out })
  const traceFile = createWriteStream(tracePath, { flags: "a" })

  try {
    await runBriefing({
      job,
      slot,
      briefs: createBriefStore(objects),
      recordArtifact: dryRunRecordArtifact,
      recordFindings: dryRunRecordFindings,
      trace: createSink(options, traceFile),
    })
  } catch {
    // Deliberately swallowed. The trace's closing event already carried this
    // error, and the run report line under it carried it again — a third copy
    // from the top-level handler would be noise. The exit code still says the
    // run failed.
    process.exitCode = 1
  } finally {
    await new Promise<void>((done) => traceFile.end(done))

    if (!options.json) {
      for (const path of objects.written) {
        process.stdout.write(`  brief  ${path}\n`)
      }
      process.stdout.write(`  trace  ${tracePath}\n\n`)
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\n${error instanceof Error ? error.message : String(error)}\n\n`
  )
  process.exitCode = 1
})
