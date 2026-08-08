import type { CoverLetterPromise } from "@/components/briefings/cover-letter-cell"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/**
 * Said once for the whole page when the cover letters could not be read.
 *
 * Beside the table rather than instead of it: letters live in S3 and the
 * dashboard's `prod:cover-letters` grant is a Terraform apply away from the code
 * that needs it. Without this a storage failure looks identical to "no letter
 * drafted", which is the wrong thing to tell someone who already drafted one.
 *
 * **A component that awaits, rather than a flag the page sets in a `catch`.**
 * The page no longer awaits the letters at all — see
 * `app/(app)/jobs/page.tsx` — so there is no `try` block left for this to
 * be decided in. Rendered inside `<Suspense fallback={null}>`, which is what
 * keeps the alert's own wait off the critical path: nothing appears here until
 * the storage reads have finished, and in the ordinary case nothing appears at
 * all.
 *
 * ⚠️ **`null` is the failure, and an empty array is not.** Awaiting a promise
 * that resolves `[]` means the store answered and this user has drafted nothing.
 * Treating the two the same would put a red alert above a perfectly healthy page
 * belonging to anyone who has not written a letter yet.
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
