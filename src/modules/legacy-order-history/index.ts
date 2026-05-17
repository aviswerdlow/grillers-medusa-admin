import { Module } from "@medusajs/framework/utils"
import LegacyOrderHistoryModuleService from "./service"

export const LEGACY_ORDER_HISTORY_MODULE = "legacy_order_history"

export default Module(LEGACY_ORDER_HISTORY_MODULE, {
  service: LegacyOrderHistoryModuleService,
})
