import { CreateBriefingForm } from "@/components/jobs/schedules/create-briefing-form"
import { EditCriteriaForm } from "@/components/jobs/schedules/edit-criteria-form"
import { JobEnabledSwitch } from "@/components/jobs/schedules/job-enabled-switch"
import { JobScheduleForm } from "@/components/jobs/schedules/job-schedule-form"
import { getPrisma } from "@/lib/db"
import {
  toBriefingSummary,
  type BriefingSummary,
} from "@/lib/jobs/briefing-summary"
import { Badge } from "@workspace/ui/components/badge"
import { Empty, EmptyDescription } from "@workspace/ui/components/empty"

/**
 * The whole of `/jobs/schedules` — every briefing the user has, and the form
 * that adds one.
 *
 * A server component: it reads the jobs and flattens every `Date` to a string
 * before anything crosses into a client component. See `briefing-summary.ts` for
 * why that boundary matters.
 */
export async function BriefingSection({ userId }: { userId: string }) {
  const jobs = await getPrisma().job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  })
  const briefings = jobs.map(toBriefingSummary)

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-medium">Briefings</h2>
        <p className="text-sm text-muted-foreground">
          A briefing searches for postings on a schedule and files the results
          privately. Turning one off leaves it and its criteria intact — it
          simply stops being due.
        </p>
      </div>

      {briefings.length === 0 ? (
        <>
          <Empty>
            <EmptyDescription>
              No briefings yet. Create one below to start receiving them.
            </EmptyDescription>
          </Empty>
          <CreateBriefingForm />
        </>
      ) : (
        <>
          {briefings.map((briefing) => (
            <BriefingCard key={briefing.id} briefing={briefing} />
          ))}
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Add another briefing
            </summary>
            <div className="pt-4">
              <CreateBriefingForm />
            </div>
          </details>
        </>
      )}

      {/*
        Said plainly because the alternative is a silent one. Someone can turn a
        briefing on here, wait a day, and get nothing — because the tick itself
        is off, which is a Terraform setting (`schedule_enabled`) that this page
        can neither read nor change.
      */}
      <p className="text-sm text-muted-foreground">
        Briefings run on the hour. If the worker has been taken off duty by an
        operator, nothing runs regardless of what is set here.
      </p>
    </section>
  )
}

function BriefingCard({ briefing }: { briefing: BriefingSummary }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{briefing.name}</span>
            <Badge variant={briefing.enabled ? "secondary" : "outline"}>
              {briefing.enabled ? "On" : "Off"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{briefing.schedule}</p>
          <p className="text-sm text-muted-foreground">
            {briefing.nextRun
              ? `Next run ${briefing.nextRun}`
              : "Not scheduled."}
          </p>
          {/*
            Said out loud because the alternative is silent data loss. A row
            written by hand can hold an expression the picker cannot express —
            `0 3 1 1 *` is a real example from this database — and saving the
            form below replaces it with one of the four intervals.
          */}
          {briefing.intervalHours ? null : (
            <p className="text-sm text-muted-foreground">
              This schedule was set outside the app. Saving below replaces it.
            </p>
          )}
        </div>

        <JobEnabledSwitch
          jobId={briefing.id}
          enabled={briefing.enabled}
          name={briefing.name}
        />
      </div>

      <JobScheduleForm briefing={briefing} />

      {/*
        Absent when `jobs.config` is not a job-search config at all — a row
        written by hand, or a second kind of briefing arriving later with a
        config this app has never seen. `toBriefingCriteria` explains why that
        is a legitimate thing to find rather than a fault, and showing no form
        is the honest answer: a config this page cannot read is one it must not
        offer to replace with three text boxes.
      */}
      {briefing.criteria ? (
        <EditCriteriaForm
          briefingId={briefing.id}
          criteria={briefing.criteria}
        />
      ) : null}
    </div>
  )
}
