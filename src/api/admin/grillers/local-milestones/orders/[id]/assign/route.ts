import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { localMilestoneRequest } from "../../../../../../../lib/local-milestone-http"
import { assignLocalDriver, requireMilestoneActor } from "../../../../../../../lib/local-milestone-store"
import { LocalMilestoneError } from "../../../../../../../lib/local-milestones"
import { staffRole } from "../../../../../../../lib/staff-access-policy"

export const POST = (req: MedusaRequest, res: MedusaResponse) =>
  localMilestoneRequest(req, res, async (db, actor) => {
    requireMilestoneActor(actor, "milestones.office")
    const body = (req.body || {}) as Record<string, unknown>
    const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_:-]{8,128}$/.test(value)
    if (!token(body.assignment_id) || !token(body.fulfillment_id) || !token(body.driver_customer_id))
      throw new LocalMilestoneError("invalid_local_driver_assignment", 400)
    const driver = await req.scope.resolve(Modules.CUSTOMER).retrieveCustomer(body.driver_customer_id as string)
    if (!driver || driver.id !== body.driver_customer_id || staffRole(driver) !== "driver")
      throw new LocalMilestoneError("approved_driver_not_found", 422)
    return assignLocalDriver(db, { orderId: req.params.id, actor,
      assignmentId: body.assignment_id as string,
      fulfillmentId: body.fulfillment_id as string,
      driverCustomerId: body.driver_customer_id as string })
  })
