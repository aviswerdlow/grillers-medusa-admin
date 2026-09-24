import { verifiedStaffAuditFields } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { sendStaffMessage } from "../../../../../lib/communications/admin"
import { emitAdminCommunicationsRouteFailureAlert } from "../_shared/alerts"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Record<string, any>
  if (!body.to || !body.subject || !body.body) {
    res.status(400).json({ error: "to, subject, and body are required" })
    return
  }
  try {
    const result = await sendStaffMessage(req.scope, {
      to: body.to,
      subject: body.subject,
      heading: body.heading,
      body: body.body,
      stream: body.stream,
      topic: body.topic,
      order_id: body.order_id,
      profile_id: body.profile_id,
      staff_actor_email: verifiedStaffAuditFields(req).staff_actor_email,
    })
    if (!result.ok) {
      await emitAdminCommunicationsRouteFailureAlert({
        req,
        action: "send_staff_message",
        error: result.error || "sendTrackedEmail returned ok=false",
        meta: {
          stream: body.stream || "transactional",
          has_order_id: Boolean(body.order_id),
          has_profile_id: Boolean(body.profile_id),
        },
      })
    }
    res.status(result.ok ? 202 : 500).json(result)
  } catch (error) {
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "send_staff_message",
      error,
      meta: {
        stream: body.stream || "transactional",
        has_order_id: Boolean(body.order_id),
        has_profile_id: Boolean(body.profile_id),
      },
    })
    res.status(500).json({ ok: false, error: "staff_message_send_failed" })
  }
}
