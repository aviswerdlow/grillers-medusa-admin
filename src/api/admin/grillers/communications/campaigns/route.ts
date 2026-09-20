import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createCampaign } from "../../../../../lib/communications/admin"
import { validateSmsMarketingContent } from "../../../../../lib/communications/sms"
import {
  emitAdminCommunicationsRouteFailureAlert,
  respondAdminCommunicationsRouteFailure,
} from "../_shared/alerts"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const limit = Math.min(100, Number(req.query?.limit || 50))
  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const campaigns = await db("gp_campaign")
      .whereNull("deleted_at")
      .select("*")
      .orderBy("created_at", "desc")
      .limit(limit)
    res.status(200).json({ campaigns })
  } catch (error) {
    await respondAdminCommunicationsRouteFailure({
      req,
      res,
      action: "list_campaigns",
      error,
      errorCode: "campaign_list_failed",
      meta: { limit },
    })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Record<string, any>
  if (!body.name || !body.subject) {
    res.status(400).json({ error: "name and subject are required" })
    return
  }
  if (body.channel === "sms") {
    const smsError = validateSmsMarketingContent(body.sms_body)
    if (smsError) {
      res.status(400).json({
        error: smsError,
        message:
          "SMS campaigns must be marketing-only, identify Griller's Pride, include STOP instructions, and omit order or delivery language.",
      })
      return
    }
  }
  const actor = verifiedStaffActorId(req) || null
  try {
    const campaign = await createCampaign(req.scope, {
      name: body.name,
      subject: body.subject,
      segment_key: body.segment_key,
      intro: body.intro,
      body: body.body,
      cta_label: body.cta_label,
      cta_url: body.cta_url,
      scheduled_at: body.scheduled_at,
      template_key: body.template_key,
      // The creator is NOT an approver — createCampaign hard-codes
      // approved_by: null; only the Slack approve flow can set it.
      created_by: actor,
      channel: body.channel,
      sms_body: body.sms_body,
      subject_b: body.subject_b,
      coupon: body.coupon,
    })
    res.status(201).json({ campaign })
  } catch (error) {
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "create_campaign",
      error,
      meta: {
        has_segment_key: Boolean(body.segment_key),
        scheduled: Boolean(body.scheduled_at),
      },
    })
    res.status(500).json({ ok: false, error: "campaign_create_failed" })
  }
}
