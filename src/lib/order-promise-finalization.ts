import {
  ORDER_PROMISE_KEY,
  OrderPromiseError,
  readOriginalOrderPromise,
  type OrderPromise,
} from "./order-promise";

/** New reviewed orders always use the original identity/food-pricing basis.
 * An unsupported order edit cannot quietly become a new accepted baseline. */
export function originalFinalizationItems(order: any, promise: OrderPromise) {
  const items = order.items ?? [];
  if (items.length !== promise.lines.length)
    throw new OrderPromiseError("order_promise_amendment_required");
  const seen = new Set<string>();
  return items.map((item: any) => {
    const id = item.metadata?.gp_order_promise_cart_line_id;
    const line = promise.lines.find((l) => l.cart_line_id === id);
    if (
      !line ||
      seen.has(id) ||
      item.variant_id !== line.variant_id ||
      item.product_id !== line.product_id ||
      Number(item.quantity) !== line.quantity
    )
      throw new OrderPromiseError("order_promise_amendment_required");
    seen.add(id);
    return {
      id: item.id,
      title: line.customer_title,
      product_title: line.customer_title,
      product_id: line.product_id,
      variant_id: line.variant_id,
      quantity: line.quantity,
      unit_price: line.estimated_unit_price,
      subtotal: line.estimated_line_subtotal,
      total: line.estimated_line_total,
      tax_total: line.estimated_line_tax,
      metadata: {
        gp_order_promise_cart_line_id: id,
        qbd_list_id: line.qbd_list_id,
        customer_title: line.customer_title,
        pricing_mode: line.pricing_mode,
        estimated_weight_each:
          line.estimated_weight_lb === null
            ? null
            : line.estimated_weight_lb / line.quantity,
        price_per_lb: line.rate_per_lb,
      },
    };
  });
}

export async function acceptedFinalizationSource(db: any, order: any) {
  if (!order.metadata?.[ORDER_PROMISE_KEY]) return null;
  const original = await readOriginalOrderPromise(db, order.id);
  if (!original || original.id !== order.metadata[ORDER_PROMISE_KEY])
    throw new OrderPromiseError("order_promise_binding_unavailable", 503);
  return {
    promise: original.promise as OrderPromise,
    items: originalFinalizationItems(order, original.promise),
  };
}
