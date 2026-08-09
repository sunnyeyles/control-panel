import { ObjectNotFoundError } from "./errors.ts"
import { buildObjectKey } from "./keys.ts"
import type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.ts"

/**
 * An in-memory {@link UserObjectStore} that builds real keys and raises real
 * errors.
 *
 * The one test double this package publishes, deliberately: this package's
 * own facade suite and the dashboard's Posting-Document suites each carried a
 * private copy, and the private copies had diverged in exactly the two ways
 * that matter —
 *
 * - **`buildObjectKey` rather than a template string**, so a change to the
 *   key layout — or to the segment rule that layout depends on — fails in the
 *   suite rather than quietly producing a test that agrees with itself.
 * - **`ObjectNotFoundError` rather than a bare `Error`**, because that is
 *   what the S3 store raises and callers branch on the code to tell "nothing
 *   written yet" apart from "the bucket is unreachable". A plain throw sends
 *   the missing-object case down the outage path, and a refusal a suite is
 *   asserting passes for the wrong reason.
 *
 * A workspace-private package shipping a fake in `dist/` is the accepted
 * cost; it is what lets every consumer run the *real* facades over it.
 */

export interface MemoryObjectStoreOptions {
  /** The leading key segment. Defaults to `test`. */
  environment?: string
  /**
   * What every object reports as its write time. Each suite picks its own
   * instant; the default exists so a suite with no opinion need not invent
   * one.
   */
  storedAt?: Date
  /** What every stored object reports as its content type. */
  contentType?: string
}

export class MemoryObjectStore implements UserObjectStore {
  readonly puts: NewObject[] = []
  /** Every key the store was *asked* about, however the ask turned out. */
  readonly reads: string[] = []
  private readonly stored = new Map<string, StoredObject & { body: Buffer }>()

  private readonly environment: string
  private readonly storedAt: Date
  private readonly contentType: string

  constructor(options: MemoryObjectStoreOptions = {}) {
    this.environment = options.environment ?? "test"
    this.storedAt = options.storedAt ?? new Date("2026-07-28T09:00:00.000Z")
    this.contentType = options.contentType ?? "application/octet-stream"
  }

  private keyOf(ref: ObjectRef): string {
    return buildObjectKey({ environment: this.environment, ...ref })
  }

  async put(object: NewObject): Promise<StoredObject> {
    this.puts.push(object)

    const body =
      typeof object.body === "string"
        ? Buffer.from(object.body, "utf8")
        : Buffer.from(object.body)

    const entry = {
      key: this.keyOf(object),
      environment: this.environment,
      userId: object.userId,
      kind: object.kind,
      segments: object.segments,
      extension: object.extension,
      contentType: this.contentType,
      size: body.byteLength,
      storedAt: this.storedAt,
      metadata: object.metadata ?? {},
      body,
    }

    this.stored.set(entry.key, entry)
    return entry
  }

  async get(ref: ObjectRef): Promise<FetchedObject> {
    const found = this.stored.get(this.keyOf(ref))
    if (!found) throw new ObjectNotFoundError(this.keyOf(ref))

    return {
      ...found,
      body: found.body,
      text: () => found.body.toString("utf8"),
    }
  }

  async head(ref: ObjectRef): Promise<StoredObject> {
    this.reads.push(this.keyOf(ref))
    const found = this.stored.get(this.keyOf(ref))
    if (!found) throw new ObjectNotFoundError(this.keyOf(ref))
    return found
  }

  async delete(ref: ObjectRef): Promise<void> {
    this.stored.delete(this.keyOf(ref))
  }

  async list(userId: string, kind: ObjectRef["kind"]): Promise<StoredObject[]> {
    return [...this.stored.values()]
      .filter((object) => object.userId === userId && object.kind === kind)
      .sort((left, right) => left.key.localeCompare(right.key))
  }

  keys(): string[] {
    return [...this.stored.keys()]
  }
}
