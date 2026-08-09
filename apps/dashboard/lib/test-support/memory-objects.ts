import { ObjectNotFoundError } from "@workspace/user-storage/errors"
import { buildObjectKey } from "@workspace/user-storage/keys"
import type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "@workspace/user-storage/user-object-store"

import { ENVIRONMENT } from "./identities"

/**
 * An in-memory {@link UserObjectStore} that builds real keys.
 *
 * `buildObjectKey` rather than a template string, so a change to the key layout
 * — or to the segment rule that layout depends on — fails in the suite rather
 * than quietly producing a test that agrees with itself. That is what makes a
 * "writes the expected key" assertion mean anything, and it is why both
 * **Posting Document** suites run the *real* store facade over this rather than
 * stubbing the facade.
 */
export class MemoryObjects implements UserObjectStore {
  readonly puts: NewObject[] = []
  /** Every key the store was *asked* about, however the ask turned out. */
  readonly reads: string[] = []
  private readonly stored = new Map<string, StoredObject & { body: Buffer }>()

  /**
   * @param storedAt what every object reports as its write time. Each suite
   * picks its own instant; nothing here has an opinion about which.
   */
  constructor(private readonly storedAt: Date) {}

  private keyOf(ref: ObjectRef): string {
    return buildObjectKey({ environment: ENVIRONMENT, ...ref })
  }

  async put(object: NewObject): Promise<StoredObject> {
    this.puts.push(object)

    const body =
      typeof object.body === "string"
        ? Buffer.from(object.body, "utf8")
        : Buffer.from(object.body)

    const entry = {
      key: this.keyOf(object),
      environment: ENVIRONMENT,
      userId: object.userId,
      kind: object.kind,
      segments: object.segments,
      extension: object.extension,
      contentType: "text/markdown; charset=utf-8",
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

  // ⚠️ `ObjectNotFoundError` rather than a bare `Error`, because that is what
  // the S3 store raises and a save action branches on the code to tell "nothing
  // written yet" apart from "the bucket is unreachable". A plain throw here
  // would send the missing-object case down the outage path, and the refusal a
  // suite is asserting would pass for the wrong reason.
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
