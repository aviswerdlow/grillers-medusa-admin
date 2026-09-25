import { Module } from "@medusajs/framework/utils"
import GpLocalEvidenceFileService from "./service"

// Medusa's FILE module permits exactly one provider. Keep the existing public
// media provider there and register this compatible private provider separately.
export const GP_LOCAL_EVIDENCE_MODULE = "gp_local_evidence"

export default Module(GP_LOCAL_EVIDENCE_MODULE, {
  service: GpLocalEvidenceFileService,
})
