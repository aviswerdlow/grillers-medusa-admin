import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { LocalEvidenceError } from "../lib/local-evidence-contract"
import { configuredEvidenceRetention, pruneExpiredEvidence, type EvidencePruneReport } from "../lib/local-evidence-storage"
import { GP_LOCAL_EVIDENCE_MODULE } from "../modules/gp-local-evidence"
import type GpLocalEvidenceFileService from "../modules/gp-local-evidence/service"

export default async function gpLocalEvidenceRetention(container: MedusaContainer) {
  if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true") return
  const logger = container.resolve("logger")
  let report: EvidencePruneReport | undefined
  try {
    const retention = configuredEvidenceRetention()
    const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const provider = container.resolve(GP_LOCAL_EVIDENCE_MODULE) as GpLocalEvidenceFileService
    await pruneExpiredEvidence(db, provider, new Date(), retention, (result) => { report = result })
    logger.info(`[gp-local-evidence-retention] ${JSON.stringify({ retentionDays: retention.days, ...report })}`)
  } catch (error) {
    const name = error instanceof LocalEvidenceError ? error.code
      : error instanceof Error ? error.name : "unknown"
    const code = /^[a-zA-Z0-9_]{1,64}$/.test(name) ? name : "unknown"
    logger.error(`[gp-local-evidence-retention] ${JSON.stringify({ event: "prune_failed", ...report, errorCode: code })}`)
    throw error
  }
}

export const config = { name: "gp-local-evidence-retention", schedule: "0 4 * * *" }
