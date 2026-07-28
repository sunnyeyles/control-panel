import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"
import { createDb } from "@workspace/db"

import { runTick } from "./run-tick.ts"

/**
 * The one file in the worker that knows it runs on AWS.
 *
 * `run-tick.ts` and `run-scheduled-task.ts` are deliberately
 * platform-independent, so everything platform-shaped — the handler signature,
 * and fetching secrets — is confined here. Moving to another runtime means
 * rewriting this file and nothing else.
 */

/**
 * Module scope, so a warm invocation reuses fetched secrets. Lambda freezes the
 * process between invocations rather than tearing it down, which makes module
 * scope the natural cache and holds this to one Secrets Manager call per secret
 * per cold start rather than one per invocation.
 *
 * Note what is deliberately *not* cached this way: the database connection. A
 * secret is a string and stays valid; a socket does not. The gap between ticks
 * is an hour and Neon autosuspends after five minutes, so a cached connection
 * is dead by the next invocation as the default outcome — which is why
 * `createDb()` is called per invocation below and closed in a `finally`.
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
 * constructors is what keeps `@workspace/agents-core` and `@workspace/db` free
 * of any knowledge of where their configuration comes from. From their point of
 * view it is just an environment variable; fetching it is this file's job
 * alone.
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
 * Both secrets, in parallel — two cold-start round trips that have no reason to
 * be sequential.
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
  ])
}

/**
 * The scheduled entry point.
 *
 * EventBridge Scheduler invokes this **hourly**, and the tick's cadence — not
 * any job's — is what lives in Terraform. That keeps the one thing every job
 * shares reviewable in a diff, while a job's own schedule is a row that costs
 * an INSERT to add rather than an apply.
 *
 * The payload is ignored on purpose. Nothing job-specific is passed in: the
 * tick asks the database what is due, so a slot is identified by a value read
 * from a row rather than by a clock or a scheduler's idea of "today".
 *
 * Nothing is caught, on purpose. A throw is the contract: it marks the
 * invocation failed and produces the `Errors` datapoint the alarm watches, so a
 * bad run is visible without anyone reading logs. `runTick()` has already
 * emitted its tick report, and each failing run its own report, by the time it
 * rethrows.
 */
export const handler = async (): Promise<void> => {
  await loadSecrets()

  // One connection per invocation, closed at the end. Not module scope: see the
  // note above.
  const db = createDb()

  try {
    await runTick(db)
  } finally {
    await db.close()
  }
}
