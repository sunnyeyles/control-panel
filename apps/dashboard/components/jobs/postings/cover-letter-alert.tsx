import type { CoverLetterPromise } from "@/components/jobs/postings/cover-letter-cell"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/**
 * Said once for the whole page when the cover letters could not be read.
 *
 * Beside the table rather than instead of it: without this a storage failure
 * looks identical to "no letter drafted", which is the wrong thing to tell
 * someone who already drafted one.
 *
 * **A component that awaits, rather than a flag the page sets in a `catch`** —
 * the page no longer awaits the letters, so there is no `try` block left to
 * decide it in. Rendered inside `<Suspense fallback={null}>`, which keeps its
 * wait off the critical path.
 *
 * ⚠️ **`null` is the failure, and an empty array is not.** `[]` means the store
 * answered and nothing is drafted; conflating them puts a red alert above a
 * healthy page belonging to anyone yet to write a letter.
 */
export async function CoverLetterAlert({
  letters,
}: {
  letters: CoverLetterPromise
}) {
  const rows = await letters

  if (rows !== null) return null

  return (
    <Alert variant="destructive">
      <AlertDescription>
        Your cover letters could not be loaded. Try again in a moment.
      </AlertDescription>
    </Alert>
  )
}
