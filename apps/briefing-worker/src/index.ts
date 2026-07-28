import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"

import { runScheduledTask } from "./run-scheduled-task.js"

/**
 * The one file in the worker that knows it runs on AWS.
 *
 * `run-scheduled-task.ts` is deliberately platform-independent, so everything
 * platform-shaped — the handler signature, and fetching the API key — is
 * confined here. Moving to another runtime means rewriting this file and
 * nothing else.
 */

/**
 * Module scope, so a warm invocation reuses the fetched key. Lambda freezes the
 * process between invocations rather than tearing it down, which makes module
 * scope the natural cache and holds this to one Secrets Manager call per cold
 * start rather than one per invocation.
 */
let secretLoaded = false

/**
 * Put the key where `getOpenAIApiKey()` already looks.
 *
 * Setting the environment variable rather than threading an `apiKey` through
 * `createAgent` is what keeps `packages/agents-core` and the task itself free
 * of any knowledge of where the secret comes from. From the application's point
 * of view it is just an environment variable; fetching it is this file's job
 * alone.
 *
 * A no-op when OPENAI_API_KEY is already set, which is what makes local
 * invocation work with no AWS credentials at all.
 */
async function loadSecret(): Promise<void> {
  if (secretLoaded || process.env.OPENAI_API_KEY) return

  const secretId = process.env.OPENAI_SECRET_ID
  if (!secretId) {
    throw new Error(
      "Neither OPENAI_API_KEY nor OPENAI_SECRET_ID is set, so there is no way to reach the model."
    )
  }

  // Region comes from the AWS_REGION the Lambda runtime sets, so there is no
  // second place for it to drift from where the function actually runs.
  const client = new SecretsManagerClient({})
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  )

  if (!SecretString) {
    throw new Error(
      `Secret ${secretId} holds no string value. Terraform creates it empty on purpose — set it once by hand.`
    )
  }

  process.env.OPENAI_API_KEY = SecretString
  secretLoaded = true
}

/**
 * The scheduled entry point. EventBridge Scheduler invokes this once a day; the
 * cadence lives in Terraform rather than here, which keeps it reviewable in a
 * diff instead of drifting invisibly in console configuration.
 *
 * Nothing is caught, on purpose. A throw is the contract: it marks the
 * invocation failed and produces the `Errors` datapoint the alarm watches, so a
 * bad run is visible without anyone reading logs. `runScheduledTask()` has
 * already emitted its one-line report by the time it rethrows.
 */
export const handler = async (): Promise<void> => {
  await loadSecret()
  await runScheduledTask()
}
