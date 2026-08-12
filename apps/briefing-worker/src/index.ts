import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"
import { createPrismaClient } from "@workspace/db"
import {
  createBriefStore,
  createS3UserObjectStore,
} from "@workspace/user-storage"
import { initializeLangfuse, shutdownLangfuse } from "@workspace/langfuse"

import { z } from "zod"

import { runAdHocBriefing } from "./run-ad-hoc.ts"
import { runTick } from "./run-tick.ts"

/**
 * The one file in the worker that knows it runs on AWS.
 *
 * `run-tick.ts` and `run-briefing.ts` are deliberately platform-independent, so
 * everything platform-shaped — the handler signature, fetching secrets, and
 * reaching S3 — is confined here. Moving to another runtime means rewriting
 * this file and nothing else.
 */

/**
 * Module scope, so a warm invocation reuses fetched secrets: Lambda freezes the
 * process rather than tearing it down, holding this to one Secrets Manager call
 * per secret per cold start.
 *
 * The database client is deliberately *not* cached this way. A secret is a
 * string and stays valid; a socket does not. Ticks are an hour apart and Neon
 * autosuspends after five minutes, so a cached connection is dead by default —
 * hence `createPrismaClient()` per invocation, disconnected in a `finally`.
 */
const loaded = new Set<string>()

/**
 * Region comes from the AWS_REGION the Lambda runtime sets, so there is no
 * second place for it to drift from where the function actually runs. Built
 * lazily so a local invocation with both variables already set never
 * constructs it, and therefore needs no AWS credentials at all.
 */
let secrets: SecretsManagerClient | undefined

/**
 * Put a secret where the code that needs it already looks.
 *
 * Setting an environment variable rather than threading values through
 * constructors keeps `@workspace/agents-core` and `@workspace/db` ignorant of
 * where their configuration comes from; fetching it is this file's job alone.
 *
 * A no-op when `variable` is already set, which is what makes local invocation
 * work with no AWS credentials.
 */
async function loadSecret(
  variable: string,
  secretIdVariable: string,
  missing: string
): Promise<void> {
  if (loaded.has(variable) || process.env[variable]) return

  const secretId = process.env[secretIdVariable]
  if (!secretId) throw new Error(missing)

  secrets ??= new SecretsManagerClient({})
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  )

  if (!SecretString) {
    throw new Error(
      `Secret ${secretId} holds no string value. Terraform creates it empty on purpose — set it once by hand.`
    )
  }

  process.env[variable] = SecretString
  loaded.add(variable)
}

/**
 * Every secret, in parallel — cold-start round trips that have no reason to be
 * sequential.
 */
async function loadSecrets(): Promise<void> {
  await Promise.all([
    loadSecret(
      "OPENAI_API_KEY",
      "OPENAI_SECRET_ID",
      "Neither OPENAI_API_KEY nor OPENAI_SECRET_ID is set, so there is no way to reach the model."
    ),
    loadSecret(
      "DATABASE_URL",
      "DATABASE_SECRET_ID",
      "Neither DATABASE_URL nor DATABASE_SECRET_ID is set, so there is no way to find out what is due."
    ),
    loadSecret(
      "APIFY_TOKEN",
      "APIFY_SECRET_ID",
      "Neither APIFY_TOKEN nor APIFY_SECRET_ID is set, so there is no way to search SEEK."
    ),
    loadSecret(
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_PUBLIC_KEY_SECRET_ID",
      "Neither LANGFUSE_PUBLIC_KEY nor LANGFUSE_PUBLIC_KEY_SECRET_ID is set, so Langfuse tracing cannot be configured."
    ),
    loadSecret(
      "LANGFUSE_SECRET_KEY",
      "LANGFUSE_SECRET_KEY_SECRET_ID",
      "Neither LANGFUSE_SECRET_KEY nor LANGFUSE_SECRET_KEY_SECRET_ID is set, so Langfuse tracing cannot be configured."
    ),
  ])
}

/**
 * What the function can be asked to do.
 *
 * **An absent `kind` is the tick**, permanently — EventBridge Scheduler and
 * `aws lambda invoke --payload '{}'` both send `{}`. That also makes the ad-hoc
 * path opt-in by construction: reaching it requires the exact discriminator.
 *
 * The loose object is deliberate: EventBridge and the console decorate payloads
 * with fields of their own, and a strict object would reject the invocation.
 */
const adHocPayloadSchema = z.object({
  kind: z.literal("ad-hoc-run"),
  runId: z.uuid(),
  jobId: z.uuid(),
})

const payloadSchema = z
  .looseObject({ kind: z.string().optional() })
  .nullish()
  .transform((value) => value ?? {})

/**
 * The entry point, for both ways in.
 *
 * EventBridge Scheduler invokes this **hourly** with an empty payload; only the
 * tick's cadence lives in Terraform, so a job's own schedule costs an INSERT
 * rather than an apply. The dashboard invokes it asynchronously with an
 * `ad-hoc-run` payload naming a `runs` row it has already inserted, claiming no
 * slot. The payload is read here and nowhere else, since `run-tick.ts` and
 * `run-ad-hoc.ts` are platform-independent.
 *
 * **The two paths treat failure differently, deliberately.** The tick rethrows,
 * producing the `Errors` datapoint the alarm watches. An ad-hoc run records the
 * failure on the row and returns — see `run-ad-hoc.ts`.
 */
export const handler = async (event?: unknown): Promise<void> => {
  const payload = payloadSchema.parse(event)
  const adHoc = adHocPayloadSchema.safeParse(payload)

  // Named before any work: a payload that carries the discriminator but not a
  // usable body must not silently fall through and run the whole tick instead.
  if (!adHoc.success && payload.kind !== undefined) {
    throw new Error(
      `Unrecognised payload kind ${JSON.stringify(payload.kind)}. Omit "kind" entirely to run the hourly tick.`
    )
  }

  await loadSecrets()
  const langfuseEnabled = initializeLangfuse({ exportMode: "immediate" })

  // One client per invocation, disconnected at the end. Not module scope: see
  // the note above.
  const prisma = createPrismaClient()

  try {
    // Built here rather than at module scope for the same reason the agents are
    // factories: constructing the store reads `USER_STORAGE_BUCKET_NAME` and
    // `USER_STORAGE_ENVIRONMENT`, and a module-level instance would move that
    // failure to import time. Inside the `try` so a throw still reaches the
    // `finally` — a client left connected across a freeze is one Neon keeps
    // accounting for.
    const briefs = createBriefStore(createS3UserObjectStore())

    if (adHoc.success) {
      await runAdHocBriefing(prisma, briefs, {
        runId: adHoc.data.runId,
        jobId: adHoc.data.jobId,
      })
      return
    }

    await runTick(prisma, briefs)
  } finally {
    await Promise.all([
      prisma.$disconnect(),
      ...(langfuseEnabled ? [shutdownLangfuse()] : []),
    ])
  }
}
