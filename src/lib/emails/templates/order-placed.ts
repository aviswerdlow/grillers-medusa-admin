import { renderEmail, renderTextFromLines, STOREFRONT_URL } from "../layout"
import {
  formatMoney,
  renderItemRows,
  renderTotalsTable,
  renderAddressBlock,
  renderHighlightCard,
  formatCityStateZip,
  escapeHtml,
  renderTextItemRows,
} from "../components"
import {
  getFulfillmentInfo,
  getPaymentLabel,
  type OrderForEmail,
} from "../order-fetch"

export const buildOrderPlacedEmail = (order: OrderForEmail) => {
  const currency = (order.currency_code || "USD").toUpperCase()
  const display = order.display_id ? `#${order.display_id}` : ""
  const orderUrl = `${STOREFRONT_URL}/us/order/${order.id}/confirmed`
  const {
    isPickup,
    isLocalDelivery,
    scheduledDate,
    scheduledWindow,
    shippingMethodName,
  } = getFulfillmentInfo(order)
  const paymentLabel = getPaymentLabel(order)
  const orderTotal = formatMoney(order.total, currency)

  const arrivalSummary = [scheduledDate, scheduledWindow].filter(Boolean).join(" · ")
  const fulfillmentNote = isPickup
    ? "Please bring a photo ID and your order number when you arrive."
    : isLocalDelivery
      ? "Please make sure someone can receive your local delivery."
      : "You'll receive a tracking number by email once your order ships."
  const fulfillmentCard = isPickup
    ? renderHighlightCard({
        label: "Pickup details",
        title: shippingMethodName,
        subtitle: arrivalSummary
          ? `Scheduled for ${arrivalSummary}`
          : "We'll email you when your order is ready.",
        note: fulfillmentNote,
      })
    : renderHighlightCard({
        label: "Delivery details",
        title: shippingMethodName,
        subtitle: arrivalSummary
          ? `Expected delivery ${arrivalSummary}`
          : undefined,
        note: fulfillmentNote,
      })

  const totalsRows: Array<{ label: string; value: string; emphasize?: boolean }> = [
    { label: "Subtotal", value: formatMoney(order.subtotal, currency) },
    { label: "Shipping", value: formatMoney(order.shipping_total, currency) },
  ]
  if (Number(order.discount_total) > 0) {
    totalsRows.push({
      label: "Discount",
      value: `-${formatMoney(order.discount_total, currency)}`,
    })
  }
  totalsRows.push({
    label: "Taxes (estimated)",
    value: formatMoney(order.tax_total, currency),
  })
  totalsRows.push({
    label: "Estimated total",
    value: formatMoney(order.total, currency),
    emphasize: true,
  })

  const addressBlock = renderAddressBlock(order.shipping_address || undefined)
  const stepThree = isPickup ? "Ready for pickup" : isLocalDelivery ? "Out for local delivery" : "Ships from Griller's Pride"

  const bodyHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBFAF6;border:1px solid #E4DED2;border-radius:6px;margin-bottom:22px;">
      <tr>
        <td style="padding:18px 20px;">
          <div style="font-size:11px;letter-spacing:0;text-transform:uppercase;color:#8B5E2D;font-weight:700;margin-bottom:8px;">Order received</div>
          <div style="font-size:22px;line-height:1.25;color:#17201A;font-weight:700;">We're preparing your order.</div>
          <div style="font-size:14px;line-height:1.55;color:#6F665B;margin-top:8px;">Your card is saved securely but not charged today. Final catch-weight items are weighed before fulfillment, and we will email the final charge after packing.</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">
            <tr>
              <td align="center" valign="top" style="width:33.33%;padding:0 4px;vertical-align:top;">
                <div style="height:6px;background:#0B5A43;border-radius:4px;"></div>
              </td>
              <td align="center" valign="top" style="width:33.33%;padding:0 4px;vertical-align:top;">
                <div style="height:6px;background:#CBA86F;border-radius:4px;"></div>
              </td>
              <td align="center" valign="top" style="width:33.33%;padding:0 4px;vertical-align:top;">
                <div style="height:6px;background:#E4DED2;border-radius:4px;"></div>
              </td>
            </tr>
            <tr>
              <td align="center" valign="top" style="width:33.33%;padding:8px 4px 0 4px;vertical-align:top;">
                <div style="font-size:11px;color:#17201A;font-weight:700;line-height:1.25;">Received</div>
              </td>
              <td align="center" valign="top" style="width:33.33%;padding:8px 4px 0 4px;vertical-align:top;">
                <div style="font-size:11px;color:#17201A;font-weight:700;line-height:1.25;">Butcher review</div>
              </td>
              <td align="center" valign="top" style="width:33.33%;padding:8px 4px 0 4px;vertical-align:top;">
                <div style="font-size:11px;color:#6F665B;font-weight:700;line-height:1.25;">${escapeHtml(stepThree)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    ${fulfillmentCard}
    <div style="font-size:11px;letter-spacing:0;text-transform:uppercase;color:#8B5E2D;font-weight:700;margin-bottom:12px;">Items ordered</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">${renderItemRows(order.items, currency)}</table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
      <tr>
        <td valign="top" class="stack-col stack-col-first" style="width:50%;padding-right:24px;">
          <div style="font-size:11px;letter-spacing:0;text-transform:uppercase;color:#8B5E2D;font-weight:700;margin-bottom:10px;">${isPickup ? "Pickup contact" : "Shipping address"}</div>
          <div style="font-size:14px;line-height:1.6;color:#17201A;">${addressBlock || '<span style="color:#6F665B;">Not provided</span>'}</div>
        </td>
        <td valign="top" class="stack-col" style="width:50%;padding-left:24px;border-left:1px solid #E4DED2;">
          <div style="font-size:11px;letter-spacing:0;text-transform:uppercase;color:#8B5E2D;font-weight:700;margin-bottom:10px;">Payment</div>
          <div style="font-size:14px;color:#17201A;margin-bottom:18px;">${escapeHtml(paymentLabel)}</div>
          ${renderTotalsTable(totalsRows)}
        </td>
      </tr>
    </table>`

  const footerNote = `
    <strong style="color:#17201A;">A note on catch-weight pricing.</strong> Most cuts are sold by the pound. Your card is saved today, and we charge the final weighed amount when your order is packed and ready to leave. <a href="${STOREFRONT_URL}/us/page/catch-weight-pricing">Learn more</a>.`

  const { html } = renderEmail({
    preheader: `Order confirmed${display ? " " + display : ""}: total ${orderTotal}.`,
    eyebrow: "Order confirmed",
    heading: display ? `Order ${display}` : "Order confirmed",
    intro:
      "Thanks for your order. We've received it and our butchers are on it.",
    bodyHtml,
    ctaUrl: orderUrl,
    ctaLabel: "View order",
    footerNote,
  })

  const cityStateZip = formatCityStateZip(order.shipping_address || ({} as any))
  const text = renderTextFromLines([
    `Order confirmed${display ? " " + display : ""}`,
    "",
    "Thanks for your order. We've received it and our butchers are on it.",
    "",
    `${shippingMethodName}${arrivalSummary ? ": " + arrivalSummary : ""}`,
    fulfillmentNote,
    "",
    "Items:",
    ...renderTextItemRows(order.items, currency),
    "",
    isPickup ? "Pickup contact:" : "Shipping to:",
    `${order.shipping_address?.first_name || ""} ${order.shipping_address?.last_name || ""}`.trim(),
    order.shipping_address?.address_1 || "",
    order.shipping_address?.address_2 || "",
    cityStateZip,
    order.shipping_address?.phone || "",
    "",
    `Subtotal: ${formatMoney(order.subtotal, currency)}`,
    `Shipping: ${formatMoney(order.shipping_total, currency)}`,
    Number(order.discount_total) > 0
      ? `Discount: -${formatMoney(order.discount_total, currency)}`
      : "",
    `Taxes (estimated): ${formatMoney(order.tax_total, currency)}`,
    `Estimated total: ${formatMoney(order.total, currency)}`,
    "",
    `View order: ${orderUrl}`,
  ])

  return {
    subject: `Order confirmed${display ? " " + display : ""} - Griller's Pride`,
    html,
    text,
  }
}
