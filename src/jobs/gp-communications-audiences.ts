import type { MedusaContainer } from "@medusajs/framework/types"
import { refreshSegmentMembership } from "../lib/communications/admin"
import { emitCommunicationsScheduledJobFailureAlert } from "../lib/communications-job-alerts"

/** Membership only: never run campaigns, enroll flows or contact a customer. */
export default async function gpCommunicationsAudiences(container: MedusaContainer) {
  const logger = container.resolve("logger")
  try {
    const summary = await refreshSegmentMembership(container, { onlyDue: true })
    logger.info(`[communications-audiences] ${JSON.stringify(summary)}`)
  } catch (error) {
    await emitCommunicationsScheduledJobFailureAlert({ jobName: config.name, error, logger })
    throw error
  }
}

export const config = { name: "gp-communications-audiences", schedule: "*/15 * * * *" }
