import { MedusaService } from "@medusajs/framework/utils"
import InstitutionalCreditCommitment from "./models/institutional-credit-commitment"

class GpInstitutionalCreditService extends MedusaService({
  InstitutionalCreditCommitment,
}) {}

export default GpInstitutionalCreditService
