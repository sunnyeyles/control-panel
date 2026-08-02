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
