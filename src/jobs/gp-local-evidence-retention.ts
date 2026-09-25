import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { configuredEvidenceRetention, pruneExpiredEvidence } from "../lib/local-evidence-storage"
import { GP_LOCAL_EVIDENCE_MODULE } from "../modules/gp-local-evidence"
import type GpLocalEvidenceFileService from "../modules/gp-local-evidence/service"

export default async function gpLocalEvidenceRetention(container: MedusaContainer) {
  if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true") return
  const retention = configuredEvidenceRetention()
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const provider = container.resolve(GP_LOCAL_EVIDENCE_MODULE) as GpLocalEvidenceFileService
  await pruneExpiredEvidence(db, provider, new Date(), retention)
}

export const config = { name: "gp-local-evidence-retention", schedule: "0 4 * * *" }
