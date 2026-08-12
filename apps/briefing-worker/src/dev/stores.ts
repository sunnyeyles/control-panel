import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { Findings } from "@workspace/agents"
import type { Artifact } from "@workspace/db"
import {
  buildObjectKey,
  contentTypeFor,
  dateSegments,
  toGeneratedOn,
  type FetchedObject,
  type NewObject,
  type ObjectRef,
  type StoredObject,
  type UserObjectStore,
} from "@workspace/user-storage"

/**
 * The stores the harness runs against: a local directory, and nothing.
 *
 * Deliberately built at the {@link UserObjectStore} layer rather than by faking
 * a `BriefStore`. The harness then composes the *real* `createBriefStore()` on
 * top, so the key derivation, the extension allowlist and the ownership checks
 * in `@workspace/user-storage` are the production ones — the only thing
 * replaced is the S3 call itself.
 */

export interface DirectoryObjectStore extends UserObjectStore {
  /** Absolute paths written during this run, in order. */
  readonly written: string[]
}

export interface DirectoryStoreOptions {
  /** Where the tree is rooted. Keys become paths beneath it. */
  directory: string
  /** The leading key segment. `dev`, so nothing can be mistaken for prod. */
  environment?: string
}

/**
 * A {@link UserObjectStore} that writes the object key as a path on disk.
 */
export function createDirectoryObjectStore(
  options: DirectoryStoreOptions
): DirectoryObjectStore {
  const root = resolve(options.directory)
  const environment = options.environment ?? "dev"
  const written: string[] = []

  const keyFor = (ref: ObjectRef) => buildObjectKey({ ...ref, environment })

  const unsupported = (method: string) => () =>
    Promise.reject(
      new Error(
        `The harness's object store only writes. ${method}() is not implemented, because a dry run has nothing to read back.`
      )
    )

  return {
    written,

    async put(object: NewObject): Promise<StoredObject> {
      const key = keyFor(object)
      const path = join(root, key)
      const body =
        typeof object.body === "string"
          ? Buffer.from(object.body, "utf8")
          : Buffer.from(object.body)

      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
      written.push(path)

      return {
        key,
        environment,
        userId: object.userId,
        kind: object.kind,
        segments: object.segments,
        extension: object.extension,
        contentType:
          contentTypeFor(object.kind, object.extension) ??
          "application/octet-stream",
        size: body.byteLength,
        storedAt: new Date(),
        metadata: object.metadata ?? {},
      }
    },

    get: unsupported("get") as () => Promise<FetchedObject>,
    head: unsupported("head") as () => Promise<StoredObject>,
    delete: unsupported("delete") as () => Promise<void>,
    list: unsupported("list") as () => Promise<StoredObject[]>,
  }
}

/**
 * A `recordArtifact` callback that writes no row.
 *
 * A dry run has no `runs` row to reference — `artifacts.run_id` is `NOT NULL`
 * and the foreign key is `on delete restrict` — so there is no honest row to
 * write. Returning a plausible `Artifact` keeps the run on its real code path.
 */
export async function dryRunRecordArtifact(
  runId: string,
  objectKey: string
): Promise<Artifact> {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    runId,
    objectKey,
    createdAt: new Date(),
  }
}

/**
 * A `recordPostings` callback that records nothing at all.
 *
 * A dry run has no `runs` row for `postings.first_seen_run_id` to reference, as
 * {@link dryRunRecordArtifact} has none for `artifacts.run_id`. And the findings
 * JSON this harness writes *is* the postings, before `toNewPostings` projects
 * them, so a second copy beside it would be the same data renamed.
 *
 * Takes no arguments on purpose, and still satisfies the seam structurally.
 */
export async function dryRunRecordPostings(): Promise<void> {}

/** A `recordFindings` callback, plus the paths it has written. */
export interface FindingsFileRecorder {
  (runId: string, findings: Findings): Promise<void>
  /** Absolute paths written during this run, in order. */
  readonly written: string[]
}

export interface FindingsFileOptions {
  /** Where the tree is rooted — the same `--out` the brief lands under. */
  directory: string
  /** Whose findings these are; the second segment of the key. */
  userId: string
  /** The slot the run is for, which decides the partition day. */
  occurrence: Date
  /** The leading key segment. `dev`, so nothing can be mistaken for prod. */
  environment?: string
}

/**
 * A `recordFindings` callback that writes the validated findings to disk,
 * beside the brief they produced.
 *
 * Production keeps them on the `runs` row; a dry run creates no row, and they
 * are worth keeping because they are exactly the input the `letter` CLI reads.
 *
 * A plain file, not an object. The key is the brief's own — through
 * `buildObjectKey`, so the same segment validation applies — with `.json` for
 * `.md`. It is *not* a key S3 would accept: there is no `findings` kind, and
 * adding one means a lifecycle entry and an IAM grant in Terraform.
 */
export function createFindingsFileRecorder(
  options: FindingsFileOptions
): FindingsFileRecorder {
  const root = resolve(options.directory)
  const environment = options.environment ?? "dev"
  const written: string[] = []

  const recorder = async (runId: string, findings: Findings): Promise<void> => {
    const briefKey = buildObjectKey({
      environment,
      userId: options.userId,
      kind: "briefs",
      segments: [...dateSegments(toGeneratedOn(options.occurrence)), runId],
      extension: ".md",
    })

    const path = join(root, `${briefKey.slice(0, -".md".length)}.json`)

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(findings, null, 2)}\n`, "utf8")
    written.push(path)
  }

  return Object.assign(recorder, { written })
}
