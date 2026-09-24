import { Module } from "@medusajs/framework/utils"
import GpInstitutionalCreditService from "./service"

export const GP_INSTITUTIONAL_CREDIT_MODULE = "gp_institutional_credit"

export default Module(GP_INSTITUTIONAL_CREDIT_MODULE, {
  service: GpInstitutionalCreditService,
})
