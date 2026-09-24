import { createHash } from "node:crypto"
import { renderEmail, renderTextFromLines, STOREFRONT_URL } from "./emails/layout"

export type NoticeMilestone = "pickup_ready" | "pickup_collected" | "local_dispatched" | "local_delivered"
export type LocalNoticePolicy = {
  version: string
  approvedAt: string
  startAt: string
  email: NoticeMilestone[]
  sms: NoticeMilestone[]
}

const NOTICE_MILESTONES: NoticeMilestone[] = ["pickup_ready", "pickup_collected", "local_dispatched", "local_delivered"]

/** Empty or missing policy means Peter's #359 notice decision is still held. */
export function localNoticePolicy(raw = process.env.GP_LOCAL_MILESTONE_NOTICE_POLICY): LocalNoticePolicy | null {
  if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true" || !raw) return null
  let value: Record<string, unknown>
  try { value = JSON.parse(raw) } catch { throw new Error("invalid_local_notice_policy") }
  const date = (item: unknown) => typeof item === "string" && Number.isFinite(Date.parse(item))
  const milestones = (item: unknown): item is NoticeMilestone[] => Array.isArray(item) &&
    item.every(value => NOTICE_MILESTONES.includes(value)) && new Set(item).size === item.length
  if (!value || typeof value !== "object" ||
    typeof value.version !== "string" || !/^issue-359-[a-zA-Z0-9_-]{4,64}$/.test(value.version) ||
    !date(value.approved_at) || !date(value.start_at) ||
    Date.parse(value.start_at as string) < Date.parse(value.approved_at as string) ||
    !milestones(value.email) || !milestones(value.sms)) throw new Error("invalid_local_notice_policy")
  return { version: value.version, approvedAt: value.approved_at as string,
    startAt: value.start_at as string, email: value.email, sms: value.sms }
}

export function localNoticeDestinationHash(channel: "email" | "sms" | "office", destination: string) {
  return createHash("sha256").update(`${channel}:${destination.trim().toLowerCase()}`).digest("hex")
}

export function localOrderSmsPermission(metadata: unknown) {
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, any>).order_sms_consent : null
  // Current order_sms_consent v2 authorizes UPS shipping/tracking only. It
  // cannot authorize pickup or local-delivery texts, even when granted=true.
  if (!value || value.granted !== true) return { allowed: false, reason: "missing_order_sms_consent" }
  return { allowed: false, reason: "ups_only_order_sms_consent" }
}

const copy: Record<NoticeMilestone, { heading: string; intro: string; subject: string }> = {
  pickup_ready: { heading: "Ready for collection", intro: "Your order is ready for collection. Please use the pickup details from your accepted order.", subject: "Your order is ready for collection" },
  pickup_collected: { heading: "Order collected", intro: "Our team recorded that your order was collected. If that is incorrect, please contact us.", subject: "Your order was collected" },
  local_dispatched: { heading: "Out for local delivery", intro: "Your order has left with our local delivery driver.", subject: "Your order is out for local delivery" },
  local_delivered: { heading: "Local delivery complete", intro: "Our team recorded that your order was delivered. If that is incorrect, please contact us.", subject: "Your order was delivered" },
}

export function buildLocalMilestoneEmail(input: { milestone: NoticeMilestone; orderId: string; displayId?: number | null; correction: boolean }) {
  const selected = copy[input.milestone]
  const display = input.displayId ? ` #${input.displayId}` : ""
  const subject = `${selected.subject}${display} | Griller's Pride`
  const orderUrl = `${STOREFRONT_URL}/us/order/${encodeURIComponent(input.orderId)}/confirmed`
  const intro = input.correction ? `Correction to an earlier update: ${selected.intro}` : selected.intro
  const { html } = renderEmail({
    preheader: `${selected.heading}${display}`,
    eyebrow: "Order update",
    heading: `${selected.heading}${display}`,
    intro,
    bodyHtml: "",
    ctaUrl: orderUrl,
    ctaLabel: "View order",
  })
  return { subject, html, text: renderTextFromLines([`${selected.heading}${display}`, "", intro, "", `View order: ${orderUrl}`]) }
}
