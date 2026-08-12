/**
 * The categories of user data this bucket holds.
 *
 * A kind is a key segment, an object tag, and an allowlist of file types all at
 * once. Adding one means adding an entry here and a matching entry in
 * `infra/aws/modules/user-storage`'s `object_kinds` variable — the tag is what
 * lets a lifecycle rule treat resumes differently from briefs, so a kind that
 * exists on only one side gets no retention policy at all.
 */
const OBJECT_KINDS = {
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
   * Markdown and nothing else, like briefs: text the application produced, not
   * an upload. `inline` for the same reason — these bytes did not arrive from
   * outside, so the stored-XSS argument behind `resumes`' `attachment` does not
   * apply.
   *
   * ⚠️ **Retention is deliberately not the briefs posture.** A brief is
   * regenerated daily and expiring a year of them is housekeeping; a letter is
   * written once, for one advertisement the user may already have relied on, so
   * deleting it is data loss. `infra/aws/modules/user-storage/variables.tf`
   * sets `expiration_days = null` for this kind.
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
   * ⚠️ **Not the `resumes` kind.** That is the shelf uploads go on — seven file
   * types, `attachment`, addressed by an id minted for a file this application
   * did not produce. These are generated markdown addressed by Posting, shaped
   * like a Cover Letter. Sharing a shelf would list them back to the user as
   * their own uploads and widen that kind's allowlist to text nobody uploaded.
   *
   * `inline` and `expiration_days = null`, both for the `cover-letters`
   * reasons: the bytes did not arrive from outside, and a tailored resume is
   * generated once for one advertisement the user may already have applied with.
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
 * Derived from the extension, never accepted from the caller: a supplied
 * content type is a supplied claim, and it lets a `.pdf` be stored as
 * `text/html` — the other half of the stored-XSS route `attachment` guards.
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
