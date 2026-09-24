import type { MedusaContainer } from "@medusajs/framework/types"
import { resumeBlackoutDeferredOrderSms } from "../lib/communications/transactional-sms"
import { emitCommunicationsScheduledJobFailureAlert } from "../lib/communications-job-alerts"

export default async function gpTransactionalSmsBlackoutResume(
  container: MedusaContainer
) {
  const logger = container.resolve("logger")
  try {
    const summary = await resumeBlackoutDeferredOrderSms(container)
    if (summary.processed || summary.errors) {
      logger.info(`[transactional-sms-blackout-resume] ${JSON.stringify(summary)}`)
    }
  } catch (error) {
    logger.error(
      `[transactional-sms-blackout-resume] failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    await emitCommunicationsScheduledJobFailureAlert({
      jobName: config.name,
      error,
      logger,
    })
    throw error
  }
}

export const config = {
  name: "gp-transactional-sms-blackout-resume",
  schedule: "* * * * *",
}
