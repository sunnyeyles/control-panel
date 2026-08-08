import {
  ExampleLetterImport,
  type ImportableDocument,
} from "@/components/jobs/letters/example-letter-import"
import { LetterInstructionsForm } from "@/components/jobs/letters/letter-instructions-form"
import { isReadableProfileExtension } from "@/lib/cover-letters/profile-text"
import { getPrisma } from "@/lib/db"
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/document-type-labels"
import { listDocuments } from "@/lib/documents/list-documents"
import { getResumeStore } from "@/lib/storage"
import { COVER_LETTER_WRITER_SYSTEM_PROMPT } from "@workspace/agents/cover-letter-writer"
import { coverLetterInstructions } from "@workspace/db"

/**
 * The whole of `/jobs/letters` — how a cover letter gets written, and what to
 * learn a voice from.
 *
 * A server component, like `briefing-section.tsx`: it reads the saved row and
 * the user's documents and hands the client components plain strings. Nothing
 * with a `Date` on it crosses — `DocumentSummary.uploadedAt` is one, so the
 * picker gets a name and a type label and no timestamp. See
 * `lib/jobs/briefing-summary.ts` for why that boundary matters.
 */
export async function CoverLetterSection({ userId }: { userId: string }) {
  const saved = await coverLetterInstructions(getPrisma(), userId)

  // A storage outage should cost the import picker and nothing else. The
  // instructions themselves live in Postgres, and a page that cannot reach S3
  // must still be able to save them — the same degradation
  // `app/(app)/documents/page.tsx` makes for the same reason.
  let documents: ImportableDocument[] = []

  try {
    const listed = await listDocuments(userId, getResumeStore())

    documents = listed
      // Only formats `extractProfileText` can actually turn into text. Offering
      // a `.doc` here would produce a picker entry whose only outcome is a
      // refusal.
      .filter((document) => isReadableProfileExtension(document.extension))
      // Already newest first out of `listDocuments`.
      .map((document) => ({
        file: document.file,
        name: document.displayName,
        type: document.documentType
          ? DOCUMENT_TYPE_LABELS[document.documentType]
          : "Unlabelled",
      }))
  } catch (error) {
    console.error(
      "cover-letters: could not list documents to import from",
      error
    )
  }

  return (
    <section className="flex flex-col gap-4">
      {/*
        No heading of its own. This used to be one section of `/settings` under
        an `<h1>Settings</h1>`, so it needed an `<h2>` to say which; it is now
        the whole of `/jobs/letters`, and `SiteHeader` already renders
        "Cover letters" as the `<h1>` off the same `lib/nav.ts` entry the
        sidebar and the tab bar read. A second one here would have repeated the
        page title immediately beneath itself.
      */}
      <p className="text-sm text-muted-foreground">
        What you write here is applied to every letter drafted from a posting,
        on top of the rules the writer always follows.
      </p>

      {/*
        ⚠️ **The writer's real system prompt, rendered verbatim — not a summary
        of it.** The point of showing the fixed rules is that the user is
        extending something visible instead of guessing what is already covered,
        and a hand-written paraphrase would drift away from the constant the
        moment either changed, with nothing failing to say so. Splitting on
        blank lines is the whole of the formatting.
      */}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          What the writer always does
        </summary>
        <div className="flex flex-col gap-3 pt-4">
          {COVER_LETTER_WRITER_SYSTEM_PROMPT.split(/\n{2,}/).map(
            (paragraph, index) => (
              // Keyed on position, not on the text: the list is static for a
              // given build, and two identical paragraphs in the prompt would
              // collide on a text key.
              <p key={index} className="text-sm text-muted-foreground">
                {paragraph}
              </p>
            )
          )}
        </div>
      </details>

      <LetterInstructionsForm
        instructions={saved?.instructions ?? ""}
        exampleLetter={saved?.exampleLetter ?? ""}
      />

      <ExampleLetterImport documents={documents} />
    </section>
  )
}
