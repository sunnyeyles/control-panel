import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { Artifact } from "@workspace/db"
import {
  buildObjectKey,
  contentTypeFor,
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
 * A `recordFindings` callback that writes no column.
 *
 * Same reason as above — there is no `runs` row to update — and nothing is
 * lost by it: the trace's `handoff` event already carries the findings
 * verbatim, and the harness writes that trace to disk beside the brief.
 */
export async function dryRunRecordFindings(): Promise<void> {}
