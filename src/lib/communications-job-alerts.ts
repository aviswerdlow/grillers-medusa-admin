import { emitOpsAlert } from "./ops-alert"

type LoggerLike = Parameters<typeof emitOpsAlert>[0]["logger"]

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 500)
}

function jobPath(jobName: string) {
  return `src/jobs/${jobName}.ts`
}

export function emitCommunicationsScheduledJobFailureAlert(input: {
  jobName: string
  error: unknown
  logger?: LoggerLike
}) {
  return emitOpsAlert({
    alertKind: "communications_scheduled_job_failed",
    severity: "warn",
    title: `Communications scheduled job ${input.jobName} failed`,
    path: jobPath(input.jobName),
    source: "medusa-server",
    logger: input.logger,
    meta: {
      job_name: input.jobName,
      error: redactedErrorMessage(input.error),
    },
  })
}

export function emitCommunicationsFlowStepErrorsAlert(input: {
  jobName: string
  summary: Record<string, any>
  logger?: LoggerLike
}) {
  return emitOpsAlert({
    alertKind: "communications_flow_step_errors",
    severity: "warn",
    title: `Communications flow runner reported ${Number(input.summary.errors || 0)} errored step(s)`,
    path: jobPath(input.jobName),
    source: "medusa-server",
    logger: input.logger,
    meta: {
      job_name: input.jobName,
      processed: Number(input.summary.processed || 0),
      errors: Number(input.summary.errors || 0),
      sent: Number(input.summary.sent || 0),
      skipped: Number(input.summary.skipped || 0),
      completed: Number(input.summary.completed || 0),
    },
  })
}

// Two fixed keys, independent of recipients/segments; bound repeated manual runs.
const AUDIENCE_ALERT_INTERVAL_MS = 15 * 60 * 1000
const audienceHolds = new Map<
  "refresh" | "calendar",
  { reportedAt: number; suppressed: number }
>()

export async function emitCommunicationsAudienceHoldAlert(input: {
  stage: "refresh" | "calendar"
  unavailable: number
  evaluated: number
  logger?: LoggerLike
}) {
  if (!input.unavailable) {
    audienceHolds.delete(input.stage)
    return
  }
  const now = Date.now()
  const prior = audienceHolds.get(input.stage)
  if (prior && now >= prior.reportedAt && now - prior.reportedAt < AUDIENCE_ALERT_INTERVAL_MS) {
    prior.suppressed += 1
    return
  }
  audienceHolds.set(input.stage, { reportedAt: now, suppressed: 0 })
  const meta = {
    stage: input.stage,
    unavailable: input.unavailable,
    evaluated: input.evaluated,
    suppressed_since_last_alert: prior?.suppressed || 0,
  }
  input.logger?.warn?.(`[communications-audience] ${JSON.stringify(meta)}`)
  try {
    await emitOpsAlert({
      alertKind: "communications_audience_held",
      severity: "warn",
      title: `Communications audience ${input.stage} needs review`,
      path: "src/lib/communications/admin.ts",
      source: "medusa-server",
      logger: input.logger,
      meta,
    })
  } catch {
    // An alert failure neither clears the hold nor interrupts unrelated work.
    input.logger?.warn?.("[communications-audience] hold alert unavailable")
  }
}
