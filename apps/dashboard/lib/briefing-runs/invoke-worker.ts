import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda"
import { devMockEnabled } from "@/lib/dev/mode"
import { createDevInvoker } from "@/lib/dev/fake-invoker"
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider"

/**
 * Asking the worker to run a briefing now.
 *
 * ⚠️ **The only file in the repository that imports `@aws-sdk/client-lambda`**,
 * for the reason `lib/storage.ts` is the only one outside
 * `@workspace/user-storage` importing the S3 SDK: which identity to assume
 * belongs at the composition root, so the two must decide it identically. **Read
 * `lib/storage.ts` before changing anything below** — every warning it carries
 * about `AWS_ROLE_ARN`, `VERCEL_OIDC_TOKEN` and what to memoize applies here, and
 * it is where those mistakes were actually made.
 *
 * An invoke rather than running the briefing in-process: the app holds no
 * `prod:briefs` grant and must not — `infra/aws/tests/vercel_dashboard.tftest.hcl`
 * asserts the app's and worker's storage grants stay disjoint, so the surface
 * that *renders* a briefing cannot *author* one. `lambda:InvokeFunction` is not a
 * storage grant and leaves that untouched.
 */

/**
 * The seam an action takes, so a test never constructs a client.
 *
 * Deliberately narrow: "start this run, out of band". It returns nothing,
 * because an asynchronous invocation has nothing to report beyond having been
 * accepted — the outcome arrives on the `runs` row.
 */
export interface BriefingInvoker {
  requestRun(request: { runId: string; jobId: string }): Promise<void>
}

/**
 * Memoized alongside the identity it was built for, exactly as `lib/storage.ts`
 * memoizes its `S3Client`: a client maintains a connection pool and a
 * serverless instance handling many requests should not build many.
 */
let client: LambdaClient | undefined
let builtFor: string | undefined
let invoker: BriefingInvoker | undefined

export function getBriefingInvoker(): BriefingInvoker {
  // Before any configuration is read — the two things this mode exists to not
  // need are a role and a function name.
  if (devMockEnabled()) {
    invoker ??= createDevInvoker()
    return invoker
  }

  const roleArn = oidcRoleArn()

  if (!client || builtFor !== roleArn) {
    client = createClient(roleArn)
    builtFor = roleArn
    invoker = undefined
  }

  invoker ??= createLambdaInvoker(client, functionName())
  return invoker
}

/**
 * The function to invoke.
 *
 * Read per call rather than at import time, matching the rule the rest of this
 * app follows: configuration is read when something asks for it, so a missing
 * variable surfaces at the first trigger and never during `next build`.
 */
function functionName(): string {
  const name = process.env.BRIEFING_WORKER_FUNCTION_NAME?.trim()

  if (!name) {
    throw new Error(
      "BRIEFING_WORKER_FUNCTION_NAME is not set, so there is no way to reach the worker. Terraform outputs it as `worker_function_name`."
    )
  }

  return name
}

/**
 * The role to assume on Vercel, or `undefined` anywhere else.
 *
 * ⚠️ **Branch on `AWS_ROLE_ARN` and on nothing else** — not `VERCEL`, which is
 * set during builds too, and above all not `VERCEL_OIDC_TOKEN`, which is never
 * set on a deployment because the token arrives as the per-request header
 * `x-vercel-oidc-token`. That mistake presents as a missing IAM attachment: STS
 * is never called, so there is no CloudTrail event.
 */
function oidcRoleArn(): string | undefined {
  return process.env.AWS_ROLE_ARN
}

/**
 * Region comes from `AWS_REGION`, which `readUserStorageConfig` already
 * requires — so it is set wherever this app runs, and there is no second
 * region-shaped variable for the two to drift apart on.
 */
function createClient(roleArn: string | undefined): LambdaClient {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION

  if (!roleArn) return new LambdaClient({ ...(region ? { region } : {}) })

  return new LambdaClient({
    ...(region ? { region } : {}),
    credentials: awsCredentialsProvider({ roleArn }),
  })
}

function createLambdaInvoker(
  lambda: LambdaClient,
  name: string
): BriefingInvoker {
  return {
    async requestRun(request) {
      await lambda.send(
        new InvokeCommand({
          FunctionName: name,
          // ⚠️ **`Event`, not `RequestResponse`.** A briefing takes minutes
          // against a Server Action budget that is a small fraction of that; a
          // synchronous invoke would time out on a run that is in fact
          // proceeding. The cost is that AWS delivers an `Event` invocation *at
          // least* once — which is why the worker claims the run first (see
          // `claimAdHocRun`) and this file needs no deduplication.
          InvocationType: "Event",
          Payload: Buffer.from(
            JSON.stringify({
              kind: "ad-hoc-run",
              runId: request.runId,
              jobId: request.jobId,
            })
          ),
        })
      )
    },
  }
}
