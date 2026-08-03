import type {
  Artifact as PrismaArtifact,
  Job as PrismaJob,
  Run as PrismaRun,
  User as PrismaUser,
} from "./generated/prisma/client.ts"
import type { Prisma } from "./generated/prisma/client.ts"

/**
 * Domain aliases over generated Prisma model types.
 *
 * `config` / `failure` stay JSON at the database; callers that interpret them
 * narrow with their own schemas (see the worker's `JobSearchConfigSchema`).
 */

/** Anything the pipeline puts on a job. The platform never reads inside it. */
export type JobConfig = Record<string, unknown>

/**
 * Per-source failure detail, or the warnings from a run that otherwise
 * succeeded.
 */
export type RunFailure = Record<string, unknown>

/**
 * What a run found, as its producer validated it. Opaque here: the platform
 * stores it beside the run and never reads inside it, exactly as it treats
 * `config` and `failure`.
 */
export type RunFindings = Record<string, unknown>

/**
 * `running` → `succeeded` | `failed`, and both are terminal.
 *
 * "Succeeded with warnings" is `succeeded` with a non-empty `failure`.
 */
export type RunStatus = "running" | "succeeded" | "failed"

export type User = PrismaUser
export type Job = PrismaJob
export type Run = PrismaRun
export type Artifact = PrismaArtifact

/** Narrow a Prisma JSON value to the opaque config bag the pipeline owns. */
export function asJobConfig(value: Prisma.JsonValue): JobConfig {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JobConfig
  }

  return {}
}

/** Narrow a Prisma JSON value to a failure payload, or null. */
export function asRunFailure(
  value: Prisma.JsonValue | null
): RunFailure | null {
  if (value === null) return null
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as RunFailure
  }

  return { value }
}
