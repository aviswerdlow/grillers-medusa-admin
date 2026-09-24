import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { localMilestoneRequest } from "../../../../../lib/local-milestone-http"
import { listLocalOrders } from "../../../../../lib/local-milestone-store"

export const GET = (req: MedusaRequest, res: MedusaResponse) =>
  localMilestoneRequest(req, res, async (db, actor) => ({ orders: await listLocalOrders(db, actor) }))
