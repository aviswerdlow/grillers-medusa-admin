import { renderEmail, renderTextFromLines, STOREFRONT_URL, SUPPORT_EMAIL } from "../layout"

export const buildOrderFinalChargeDeclinedEmail = (order: {
  id: string
  display_id?: string | number | null
}) => {
  const display = order.display_id ? ` #${order.display_id}` : ""
  const orderUrl = `${STOREFRONT_URL}/us/order/${encodeURIComponent(order.id)}/confirmed`
  const subject = `Action needed for your Griller's Pride order${display}`
  const { html } = renderEmail({
    preheader: "Your final card charge was declined and your order is on hold.",
    eyebrow: "Payment update",
    heading: "Your final charge did not go through",
    intro: `The final card charge for your order${display} was declined. We have placed the order on hold and have not released it for fulfillment.`,
    bodyHtml: `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Please contact our team at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> to arrange the next step. Do not place another order to resolve this charge.</p>`,
    ctaUrl: orderUrl,
    ctaLabel: "View order",
  })
  const text = renderTextFromLines([
    subject,
    "",
    `The final card charge for your order${display} was declined. Your order is on hold and has not been released for fulfillment.`,
    `Please contact ${SUPPORT_EMAIL} to arrange the next step. Do not place another order to resolve this charge.`,
    `View order: ${orderUrl}`,
  ])
  return { subject, html, text }
}
