import { Modules } from "@medusajs/framework/utils";
import { getPackagingConfig } from "./packaging-cost-strapi";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
  type ShippingPackingPlan,
} from "./shipping-packing-plan";
import {
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  ShippingInputError,
  shippingMetadata,
  shippingWeightSnapshots,
} from "./shipping-weights";
import { loadShippingCatalogLines } from "./shipping-catalog-inputs";
import { weightImportHash } from "./sam-shipping-weight-import";
import {
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
} from "../modules/fulfillment/wwex-speedship";

const CART_FIELDS = [
  "id",
  "completed_at",
  "metadata",
  "shipping_address.*",
  "shipping_methods.*",
  "items.*",
  "items.variant.id",
];
async function shippingAcceptanceContext(container: any, cartId: string) {
  const query = container.resolve("query");
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: CART_FIELDS,
    filters: { id: cartId },
  });
  const cart = carts?.[0];
  if (!cart) throw new ShippingInputError("shipping_cart_not_found");
  // Completion replay must retain the already accepted order, not recalculate it.
  if (cart.completed_at) return null;
  const methods = cart.shipping_methods ?? [];
  if (!methods.length) return null;
  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "data"],
    filters: { id: methods.map((m) => m.shipping_option_id) },
  });
  if (options.length !== new Set(methods.map((m) => m.shipping_option_id)).size)
    throw new ShippingInputError("shipping_option_not_found");
  const carriers = methods
    .map((method) => ({
      method,
      service: normalizeGrillersUpsServiceCode(
        shippingMetadata(
          options.find((o) => o.id === method.shipping_option_id)?.data,
        ).service_code,
      ),
    }))
    .filter((m) => isUpsServiceCode(m.service));
  if (!carriers.length) return null;
  if (carriers.length !== 1 || methods.length !== 1)
    throw new ShippingInputError("ambiguous_shipping_selection");
  const { method, service } = carriers[0],
    lines = await loadShippingCatalogLines(query, cart.items ?? []);
  const expected = createShippingPackingPlan(
    lines,
    { service, postalCode: cart.shipping_address?.postal_code ?? "" },
    await getPackagingConfig(process.env),
  );
  const selected = shippingMetadata(method.data)[
    SHIPPING_PACKING_PLAN_KEY
  ] as ShippingPackingPlan;
  if (!selected || weightImportHash(selected) !== weightImportHash(expected))
    throw new ShippingInputError("shipping_selection_changed_refresh_required");
  return { cart, lines, plan: selected };
}

/** Runs before completeCartWorkflow loads its own cart. The native workflow
 * copies these line and cart metadata snapshots to the newly created order. */
export async function prepareShippingAcceptance(
  container: any,
  cartId: string,
) {
  const context = await shippingAcceptanceContext(container, cartId);
  if (!context) return;
  const cartModule = container.resolve(Modules.CART);
  await cartModule.updateLineItems(
    shippingWeightSnapshots(context.lines, new Date().toISOString()),
  );
  await cartModule.updateCarts(cartId, {
    metadata: {
      ...shippingMetadata(context.cart.metadata),
      [SHIPPING_PACKING_PLAN_KEY]: context.plan,
    },
  });
}

/** Hook validates the exact cart object the core workflow will copy. A stale
 * preparation or concurrent cart mutation rejects completion before an order. */
export async function validateShippingAcceptance(
  container: any,
  loadedCart: any,
) {
  const context = await shippingAcceptanceContext(container, loadedCart.id);
  if (!context) return;
  const expectedLines = shippingWeightSnapshots(
    context.lines,
    new Date().toISOString(),
  );
  if (
    (loadedCart.items ?? []).length !== expectedLines.length ||
    weightImportHash(
      shippingMetadata(loadedCart.metadata)[SHIPPING_PACKING_PLAN_KEY] ?? null,
    ) !== weightImportHash(context.plan)
  )
    throw new ShippingInputError("shipping_acceptance_changed");
  for (const expected of expectedLines) {
    const line = loadedCart.items.find((l: any) => l.id === expected.id);
    const snapshot = shippingMetadata(line?.metadata)[
      SHIPPING_WEIGHT_SNAPSHOT_KEY
    ];
    const reference = expected.metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY];
    if (
      !snapshot ||
      !Number.isFinite(Date.parse(snapshot.captured_at)) ||
      line.variant_id !== reference.variant_id ||
      Number(line.quantity) !== reference.quantity ||
      weightImportHash({ ...snapshot, captured_at: null }) !==
        weightImportHash({ ...reference, captured_at: null })
    )
      throw new ShippingInputError("shipping_acceptance_changed");
  }
}
