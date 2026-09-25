import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { localMilestoneRequest } from "../../../../../../lib/local-milestone-http"
import { readLocalOrder } from "../../../../../../lib/local-milestone-store"

export const GET = (req: MedusaRequest, res: MedusaResponse) =>
  localMilestoneRequest(req, res, (db, actor) => readLocalOrder(db, req.params.id, actor))
