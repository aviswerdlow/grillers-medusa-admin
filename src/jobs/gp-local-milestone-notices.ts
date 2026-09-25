import type { MedusaContainer } from "@medusajs/framework/types"
import { runLocalMilestoneNotices } from "../lib/local-milestone-notices"
import { emitCommunicationsScheduledJobFailureAlert } from "../lib/communications-job-alerts"

export default async function gpLocalMilestoneNotices(container: MedusaContainer) {
  const logger = container.resolve("logger")
  try {
    const result = await runLocalMilestoneNotices(container)
    if (result.processed) logger.info(`[local-milestone-notices] ${JSON.stringify(result)}`)
  } catch (error) {
    logger.error(`[local-milestone-notices] ${error instanceof Error ? error.message : String(error)}`)
    await emitCommunicationsScheduledJobFailureAlert({ jobName: config.name, error, logger })
    throw error
  }
}

export const config = { name: "gp-local-milestone-notices", schedule: "* * * * *" }
