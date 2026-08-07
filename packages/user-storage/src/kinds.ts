/**
 * The categories of user data this bucket holds.
 *
 * A kind is a key segment, an object tag, and an allowlist of file types all at
 * once. Adding one means adding an entry here and a matching entry in
 * `infra/aws/modules/user-storage`'s `object_kinds` variable — the tag is what
 * lets a lifecycle rule treat resumes differently from briefs, so a kind that
 * exists on only one side gets no retention policy at all.
 */
export const OBJECT_KINDS = {
  /**
   * Markdown briefs written by the scheduled worker. Regenerated, never
   * uploaded, so exactly one file type.
   */
  briefs: {
    contentTypes: {
      ".md": "text/markdown; charset=utf-8",
    },
    // Fetched by the application and rendered, never handed to a browser as a
    // document.
    disposition: "inline",
  },

  /**
   * Cover letters drafted for one Posting, in the user's own voice.
   *
   * Markdown and nothing else, like briefs: this is text the application just
   * produced, not an upload, so there is exactly one file type to accept.
   *
   * `inline` for the same reason briefs are — nothing is served from the
   * bucket's origin, and the app fetches this and renders it. The stored-XSS
   * argument that makes `resumes` an `attachment` does not apply, because these
   * bytes did not arrive from outside.
   *
   * ⚠️ **Retention is deliberately the resumes posture, not the briefs one.**
   * A brief is regenerated every day and expiring a year of them is
   * housekeeping; a letter is written once, in the user's voice, for one
   * advertisement they may already have relied on. Deleting it is data loss.
   * The `object_kinds` entry in `infra/aws/modules/user-storage/variables.tf`
   * therefore sets `expiration_days = null`.
   */
  "cover-letters": {
    contentTypes: {
      ".md": "text/markdown; charset=utf-8",
    },
    disposition: "inline",
  },

  /**
   * Resumes rewritten for one Posting, from the candidate's own uploaded CV.
   *
   * ⚠️ **Not the `resumes` kind, and the distance between them is the reason.**
   * `resumes` is the shelf uploads go on: seven file types, `attachment`,
   * addressed by an id this application minted for a file it did not produce.
   * These are generated markdown addressed by Posting, in the shape a Cover
   * Letter is — one file type, `inline`, written by this application from a
   * document the user gave it. Putting them on the same shelf would list them
   * back to the user as their own uploads and would widen that kind's allowlist
   * to cover text nobody uploaded.
   *
   * `inline` for the reason `cover-letters` is: nothing is served from the
   * bucket's origin, and these bytes did not arrive from outside, so the
   * stored-XSS argument that makes `resumes` an `attachment` does not apply.
   *
   * Retention is the letters posture, not the briefs one — `expiration_days =
   * null` in `infra/aws/modules/user-storage/variables.tf`. A brief is
   * regenerated daily and expiring a year of them is housekeeping; a tailored
   * resume is generated once for one advertisement the user may already have
   * applied to with it. Deleting it is data loss.
   */
  "tailored-resumes": {
    contentTypes: {
      ".md": "text/markdown; charset=utf-8",
    },
    disposition: "inline",
  },

  /**
   * Documents the user uploaded themselves — CVs and the like.
   *
   * `attachment` matters here in a way it does not for briefs. These bytes
   * arrived from outside, and a browser that renders an uploaded file inline
   * on the bucket's origin is the standard stored-XSS route. Nothing is served
   * directly from S3 today, so this is currently belt-and-braces; it becomes
   * load-bearing the moment presigned URLs are added.
   */
  resumes: {
    contentTypes: {
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".odt": "application/vnd.oasis.opendocument.text",
      ".rtf": "application/rtf",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
    },
    disposition: "attachment",
  },
} as const

export type ObjectKind = keyof typeof OBJECT_KINDS

export function isObjectKind(value: unknown): value is ObjectKind {
  return typeof value === "string" && value in OBJECT_KINDS
}

/** The file extensions a kind accepts, lowercase and dot-prefixed. */
export function extensionsFor(kind: ObjectKind): string[] {
  return Object.keys(OBJECT_KINDS[kind].contentTypes)
}

/**
 * The media type an object is stored with.
 *
 * Derived from the extension rather than accepted from the caller, and that is
 * deliberate. A caller-supplied content type is a caller-supplied claim: it
 * lets a `.pdf` be stored as `text/html`, which is the other half of the
 * stored-XSS route the `attachment` disposition guards. Here the extension is
 * the only thing a caller chooses, and the allowlist decides the rest.
 *
 * Returns `undefined` for an extension the kind does not accept; callers turn
 * that into an {@link ../errors.js InvalidObjectKeyError}.
 */
export function contentTypeFor(
  kind: ObjectKind,
  extension: string
): string | undefined {
  const { contentTypes } = OBJECT_KINDS[kind]

  return (contentTypes as Record<string, string | undefined>)[
    extension.toLowerCase()
  ]
}

/** `inline` or `attachment`, per the kind. */
export function dispositionFor(kind: ObjectKind): string {
  return OBJECT_KINDS[kind].disposition
}
