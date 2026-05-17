import { MedusaService } from "@medusajs/framework/utils"
import LegacyCustomerMap from "./models/customer-map"
import LegacyItemMap from "./models/item-map"
import LegacyOrder from "./models/order"
import LegacyOrderLine from "./models/order-line"

class LegacyOrderHistoryModuleService extends MedusaService({
  LegacyCustomerMap,
  LegacyItemMap,
  LegacyOrder,
  LegacyOrderLine,
}) {}

export default LegacyOrderHistoryModuleService
