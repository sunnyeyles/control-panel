import {
  postingDocumentFilename,
  type PostingDocumentNameParts,
} from "@/lib/posting-documents/posting-document-filename"

/**
 * Naming the file a tailored-resume download produces.
 *
 * Imports nothing from Next, like everything else under this directory.
 *
 * ⚠️ **There is no `POSTING_ID_PATTERN` here, and that absence is the point.**
 * A tailored resume is addressed by exactly the value a cover letter is, so the
 * shape a form field or a URL segment must have before it can become a key
 * segment is stated once, for both — in
 * `lib/posting-documents/posting-document-ref.ts`, whose own comment explains at
 * length why there is one copy of it. Restating the regex under a second name is
 * precisely the drift that comment exists to prevent.
 */

export type TailoredResumeNameParts = PostingDocumentNameParts

/**
 * The filename a download is offered under.
 *
 * "Tailored resume" and not "Resume": the user's Documents shelf is full of
 * files they would call a resume, and a download landing beside them under that
 * name is one the app generated pretending to be one they wrote. The PDF export
 * derives its name from this one by swapping the extension, so the distinction
 * carries there too.
 */
export function tailoredResumeFilename(parts: TailoredResumeNameParts): string {
  return postingDocumentFilename("Tailored resume", parts)
}
