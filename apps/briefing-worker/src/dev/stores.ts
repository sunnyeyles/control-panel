import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { Artifact, ArtifactStore } from "@workspace/db"
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
 * replaced is the S3 call itself. A hand-written fake `BriefStore` would agree
 * with production right up until one of those rules changed.
 *
 * The consequence worth stating: the harness needs no AWS credentials, no
 * bucket, and no network. Watching a run work should not require permission to
 * write to production storage.
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
 *
 * The key is built by the real `buildObjectKey`, so what lands on disk is
 * exactly the layout S3 would hold — `dev/{userId}/briefs/2026/07/28/{runId}.md`
 * — and a brief can be opened in an editor without anything to unpack it.
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
        // Derived from the extension, exactly as the S3 store derives it — a
        // caller-supplied media type is a caller-supplied claim. `undefined` is
        // unreachable here: `buildObjectKey` above already rejected any
        // extension off the kind's allowlist.
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
 * An {@link ArtifactStore} that writes no row.
 *
 * A dry run has no `runs` row to reference — `artifacts.run_id` is `NOT NULL`
 * and the foreign key is `on delete restrict` — so there is no honest row to
 * write. Returning a plausible `Artifact` keeps the run on its real code path,
 * including the ordering rule that the object is written before the row.
 *
 * It keeps no record of the calls, because the trace already is one: the
 * `artifact` event carries the key and the size at the moment the object landed.
 */
export function createDryRunArtifactStore(): ArtifactStore {
  return {
    async record(runId: string, objectKey: string): Promise<Artifact> {
      return {
        id: "00000000-0000-4000-8000-000000000000",
        runId,
        objectKey,
        createdAt: new Date(),
      }
    },

    async forRun(): Promise<Artifact[]> {
      return []
    },

    async latestForJob(): Promise<Artifact | undefined> {
      return undefined
    },
  }
}
