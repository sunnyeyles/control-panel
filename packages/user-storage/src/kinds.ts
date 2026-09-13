/**
 * The categories of user data this bucket holds.
 *
 * A kind is a key segment, an object tag, and an allowlist of file types all at
 * once. Adding one means adding an entry here and a matching entry in
 * `infra/aws/modules/user-storage`'s `object_kinds` variable — the tag is what
 * a lifecycle rule filters on, so a kind that exists on only one side gets no
 * retention policy at all.
 */
const OBJECT_KINDS = {
  /**
   * Documents the user uploaded themselves — CVs and the like.
   *
   * `attachment` because these bytes arrived from outside, and a browser that
   * renders an uploaded file inline on the bucket's origin is the standard
   * stored-XSS route.
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
