import { BriefingSection } from "@/components/briefings/jobs/briefing-section"
import { requirePageUser } from "@/lib/auth/require-page-user"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * The schedules page: what a briefing searches for, and how often.
 *
 * **No `maxDuration`, unlike `/settings` and `/documents`.** Both raise it
 * because `listDocuments()` pays one `HeadObject` per document and that fan-out
 * is what threatens the default. This page reads `jobs` through Prisma — one
 * indexed query, no object store — so raising the ceiling here would be
 * cargo-culted from a page whose problem it does not share.
 */
export default async function BriefingSchedulesPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        `max-w-2xl` and these paddings are duplicated in `loading.tsx`, which
        replaces this element mid navigation — any difference between the two is
        a jump the user sees.
      */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-4 py-8 lg:px-6">
        {/*
          `user.userId` is `users.id` — the platform identity — not the Neon
          Auth id. It is what `jobs.user_id` references, so it is the only thing
          that can scope this list.
        */}
        <BriefingSection userId={user.userId} />
      </div>
    </main>
  )
}
