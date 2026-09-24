import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { localMilestoneRequest } from "../../../../../../../lib/local-milestone-http"
import { recordLocalMilestone } from "../../../../../../../lib/local-milestone-store"

export const POST = (req: MedusaRequest, res: MedusaResponse) =>
  localMilestoneRequest(req, res, (db, actor) => recordLocalMilestone(db, {
    orderId: req.params.id, actor, kind: "correction", body: req.body,
  }))
