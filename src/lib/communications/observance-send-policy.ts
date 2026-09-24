import type {
  CommunicationPurpose,
  SendTrackedEmailInput,
} from "./core"

/** Source-only rollout switch. No sender changes behavior until enabled. */
export function observanceSendPolicyEnabled(): boolean {
  return process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED === "true"
}

// Avi's September 23 decision: only these real access/order notices may be
// delivered during the Atlanta Shabbat/Yom Tov window. Physical Postmark
// stream does not determine message purpose.
const ESSENTIAL_EMAIL_TOPICS: Record<string, "account" | "order_updates"> = {
  "customer-password-reset": "account",
  "receipt-email-verification": "account",
  "order-placed": "order_updates",
  "order-final-charge": "order_updates",
  "refund-issued": "order_updates",
  "order-canceled": "order_updates",
  "order-shipped": "order_updates",
}

export const ESSENTIAL_EMAIL_BLACKOUT_POLICY_VERSION =
  "essential-email-2026-09-23"

export function approvedEssentialEmailDuringBlackout(
  input: SendTrackedEmailInput,
  purpose: CommunicationPurpose
): boolean {
  const requiredTopic = ESSENTIAL_EMAIL_TOPICS[input.template_key]
  if (!requiredTopic) return false
  if (input.staff_test) return false
  if (input.stream !== "transactional") return false
  if (requiredTopic === "order_updates" && purpose !== "transactional") {
    return false
  }
  if (
    requiredTopic === "account" &&
    purpose !== "transactional" &&
    purpose !== "service"
  ) {
    return false
  }
  if (input.topic !== requiredTopic) return false
  // Customer journeys and campaigns may contain promotional or operator-
  // edited content, even when they claim an approved template key.
  if (
    input.campaign_id ||
    input.flow_id ||
    input.flow_key ||
    input.flow_enrollment_id ||
    input.postmark_template_alias
  ) {
    return false
  }
  if (requiredTopic === "order_updates" && !input.order_id) return false
  if (requiredTopic === "account" && input.order_id) return false
  return true
}
