import {
  authenticate,
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  finalChargeSucceeded,
  isInvoiceOrder,
  metadataObject,
  orderRequiresFinalCharge,
} from "../lib/catch-weight-finalization"
import { institutionalFulfillmentDecision } from "../lib/gp-institutional-fulfillment"
import {
  isDestinationServiceable,
  resolveServiceCodeFromMethod,
  ZIP_RESTRICTED_SERVICE_CODES,
} from "../modules/fulfillment/serviceability"
import { emitOpsAlert, type OpsAlertSeverity } from "../lib/ops-alert"
import { opsErrorHandler } from "./middlewares/ops-error-handler"
import { hideShippingInternals } from "./middlewares/shipping-inputs"
import { protectCustomerStaffAuthority } from "./middlewares/customer-staff-authority"
import { enforceStaffCartAuthority } from "./middlewares/staff-cart-authority"
import {
  bindFulfillmentAudit,
  enforceStaffCapabilities,
  enforceStaffSessionEpoch,
  protectAdminCustomerAuthority,
  publishAdminStaffAccess,
  publishCurrentStaffAccess,
} from "./middlewares/staff-capabilities"
import {
  rawStripeWebhookBody,
  stripeSignatureHeader,
  verifyStripeWebhookSignature,
} from "../lib/stripe-webhook-signature"

import { filterPublicCatalog, guardNewCartItems, guardAddedCartItem, guardUpdatedCartItem, guardCompletedCart, guardCartPaymentSession, guardInventoryVariants, guardInventoryResolution } from "./middlewares/public-catalog"
import { guardCustomerContactWrite, guardCustomerProvenanceCreate } from "./middlewares/customer-contact"
import { staffRequestPath } from "../lib/staff-request-path"

const MIDDLEWARES_PATH = "src/api/middlewares.ts"

// Native Medusa authenticates this bootstrap route with allowUnregistered.
// The global admin guard must leave exactly this method and literal path to it.
function isNativeInviteAcceptance(req: MedusaRequest): boolean {
  return req.method === "POST" && staffRequestPath(req) === "/admin/invites/accept"
}

const authenticateAdminUser = authenticate("user", ["session", "bearer", "api-key"])
function authenticateAdminExceptInvite(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  return isNativeInviteAcceptance(req) ? next() : authenticateAdminUser(req, res, next)
}

function enforceStaffCapabilitiesExceptInvite(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  return isNativeInviteAcceptance(req) ? next() : enforceStaffCapabilities(req, res, next)
}

/**
 * Medusa validates Stripe signatures inside its delayed payment-webhook
 * subscriber. This front-line guard also validates before the built-in route
 * returns 200, so a missing/wrong native endpoint secret fails closed
 * synchronously instead of acknowledging an event that will fail later.
 */
export async function verifyNativeStripeWebhookSignature(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  let logger: any
  try {
    logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  } catch {
    logger = undefined
  }

  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim()
  if (!secret) {
    logger?.error?.(
      "[stripe-native-webhook] native signing secret is not configured — rejecting webhook"
    )
    void emitOpsAlert({
      alertKind: "stripe_native_webhook_secret_missing",
      title: "Stripe native Medusa webhook signing secret is missing",
      path: MIDDLEWARES_PATH,
      source: "medusa",
      severity: "page",
      logger,
      meta: {
        reason: "STRIPE_WEBHOOK_SECRET is not configured",
      },
    }).catch(() => {
      // Alerting must not change webhook response semantics.
    })
    res.status(503).json({ ok: false, error: "webhook_secret_missing" })
    return
  }

  const rawBody = rawStripeWebhookBody(req)
  const signatureHeader = stripeSignatureHeader(req.headers)
  const verdict = verifyStripeWebhookSignature({
    rawBody,
    signatureHeader,
    secret,
  })

  if (!verdict.ok) {
    void emitOpsAlert({
      alertKind: "stripe_native_webhook_invalid_signature",
      title: "Stripe native Medusa webhook rejected an invalid signature",
      path: MIDDLEWARES_PATH,
      source: "medusa",
      severity: "warn",
      logger,
      meta: {
        has_signature_header: Boolean(signatureHeader),
        has_raw_body: rawBody !== null,
        rejection_reason: verdict.reason,
      },
    }).catch(() => {
      // Alerting must not change webhook response semantics.
    })
    res.status(400).json({ ok: false, error: "invalid_signature" })
    return
  }

  return next()
}

// Each guard decides whether to block; alert delivery never grants permission.
// The consumer's dedup window absorbs hot-path volume.
// NEVER include PII — only the guard's alertKind + the error message (sliced).
function emitGuardFailureAlert(input: {
  logger: Pick<import("@medusajs/framework/types").Logger, "warn" | "error">
  alertKind: string
  severity: OpsAlertSeverity
  title: string
  error: unknown
}) {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error)
  void emitOpsAlert({
    alertKind: input.alertKind,
    severity: input.severity,
    path: MIDDLEWARES_PATH,
    title: input.title,
    meta: { error_message: message.slice(0, 300) },
    logger: input.logger,
  })
}

export async function blockFulfillmentBeforeFinalCharge(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const orderId =
    req.params.id ||
    (req.body as Record<string, any> | undefined)?.order_id ||
    (req.body as Record<string, any> | undefined)?.order?.id

  if (typeof orderId !== "string" || !orderId.trim()) {
    res.status(400).json({
      type: "invalid_request",
      message: "An order ID is required to verify payment before fulfillment.",
    })
    return
  }

  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "cart_id", "metadata"],
      filters: { id: orderId },
    })
    const order = data?.[0]
    const metadata =
      typeof order?.metadata === "string"
        ? JSON.parse(order.metadata)
        : order?.metadata

    // An absent, mismatched or incomplete row is not proof of a paid order.
    // A known null metadata value is valid for older non-catch-weight orders.
    if (
      !order ||
      order.id !== orderId ||
      metadata === undefined ||
      (metadata !== null &&
        (typeof metadata !== "object" || Array.isArray(metadata)))
    ) {
      throw new Error("Order payment state could not be established")
    }

    const verifiedOrder = { ...order, metadata }
    if (
      orderRequiresFinalCharge(verifiedOrder) &&
      !finalChargeSucceeded(verifiedOrder)
    ) {
      res.status(409).json({
        type: "payment_required",
        message:
          "This catch-weight order cannot be fulfilled until the final pre-shipment card charge succeeds.",
      })
      return
    }
    if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED === "true" && isInvoiceOrder(verifiedOrder)) {
      const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const decision = await institutionalFulfillmentDecision({ db, order: verifiedOrder })
      if (decision.status !== "allow") {
        res.status(409).json({
          type: "institutional_terms_hold",
          message: "This invoice order needs a verified release before fulfillment.",
        })
        return
      }
    }
  } catch (error) {
    res.status(503).json({
      type: "payment_verification_unavailable",
      message:
        "Payment status could not be verified. Hold the order and retry fulfillment. If this continues, contact a manager; do not charge the card again to clear this error.",
      retryable: true,
    })
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      `[catch-weight-finalization] fulfillment gate lookup failed: ${message}`
    )
    // Page for operator recovery; fulfillment remains blocked even if alert
    // delivery is unavailable. Never create an automatic bypass here.
    emitGuardFailureAlert({
      logger,
      alertKind: "mw_fulfillment_gate_failed",
      severity: "page",
      title: "middleware: fulfillment gate lookup failed (fulfillment blocked)",
      error,
    })
    return
  }

  return next()
}

// Advisory approval-hold gate. Blocks a fulfillment-creating request only when the order
// carries an active Slack review hold — i.e. `metadata.fulfillment_hold.held`
// is strictly the boolean `true`. A Slack "Hold" click sets that field; a
// "Release" click flips it to false. EVERY normal order has no fulfillment_hold
// key at all, so the strict `=== true` check means the default flow is NEVER
// blocked here.
//
// IMPORTANT contrast with the final-charge gate: that gate PAGES on a lookup
// failure and blocks fulfillment because unverifiable payment is a money risk.
// This gate is ADVISORY — failing open just
// means a held order could ship, which is exactly the pre-existing behavior
// (holds didn't exist before). Failing CLOSED here would risk blocking ALL
// fulfillment on a transient query error = a self-inflicted outage. So this gate
// fails OPEN with a warn-level alert, not a page.
export async function blockFulfillmentOnSlackHold(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const orderId =
    req.params.id ||
    (req.body as Record<string, any> | undefined)?.order_id ||
    (req.body as Record<string, any> | undefined)?.order?.id

  if (!orderId || typeof orderId !== "string") {
    return next()
  }

  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { id: orderId },
    })
    const order = data?.[0]

    const metadata = metadataObject(order?.metadata)
    const hold = metadata?.fulfillment_hold
    // STRICT === true: a missing/false/undefined hold (the default for every
    // normal order) NEVER blocks. A truthy-but-non-true object must not block.
    if (order && hold?.held === true) {
      res.status(409).json({
        type: "order_on_hold",
        message: "This order is on a Slack review hold; Release it first.",
      })
      return
    }
  } catch (error) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      `[slack-hold] fulfillment gate lookup failed (failed open): ${message}`
    )
    // Warn (not page): an advisory hold gate that fails open is the safe default
    // (worst case a held order ships = pre-existing behavior). Failing closed
    // would risk blocking ALL fulfillment on a transient error = an outage.
    emitGuardFailureAlert({
      logger,
      alertKind: "mw_slack_hold_gate_failed",
      severity: "warn",
      title:
        "middleware: slack-hold fulfillment gate lookup failed (failed open)",
      error,
    })
  }

  return next()
}

// LAYER 3 (don't offer unserviceable options): on GET /store/shipping-options,
// strip any zip/city-restricted option (Metro Atlanta Delivery / Scheduled
// Delivery) that can't serve the cart's ship-to address, so the storefront never
// presents an option that would later fail pricing.
//
// Approach: wrap res.json to post-process the body the CORE handler produces.
// We deliberately do NOT reimplement the core route — we just filter its output.
// This is robust to Medusa version changes in how options are built/priced.
//
// Fail open: if we can't resolve the cart/address, or any lookup throws, we
// return all options unfiltered. Non-restricted options always pass.
async function filterUnserviceableShippingOptions(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const cartId =
    (req.query?.cart_id as string | undefined) ||
    ((req as any).filterableFields?.cart_id as string | undefined)

  // No cart context -> can't determine a destination -> don't filter.
  if (!cartId || typeof cartId !== "string") {
    return next()
  }

  // Resolve the cart's shipping address up front; if we can't, fail open by
  // leaving res.json untouched.
  let shippingAddress: {
    postal_code?: string | null
    city?: string | null
    province?: string | null
  } | null = null
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "shipping_address.postal_code",
        "shipping_address.city",
        "shipping_address.province",
      ],
      filters: { id: cartId },
    })
    shippingAddress = (data?.[0] as any)?.shipping_address || null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      `[shipping-options-filter] cart ${cartId} address lookup failed (${message}); returning all options`
    )
    emitGuardFailureAlert({
      logger,
      alertKind: "mw_shipping_options_filter_failed",
      severity: "warn",
      title: "middleware: shipping-options filter address lookup failed",
      error,
    })
    return next()
  }

  // No address yet -> nothing to restrict against -> fail open.
  if (!shippingAddress) {
    return next()
  }

  // Wrap res.json to post-process the body the CORE handler produces. The
  // override is sync (Express contract) but needs an async Strapi check, so it
  // buffers the result, resolves serviceability for the restricted options,
  // then emits via the original res.json. Any failure falls back to the
  // unfiltered body (fail open).
  const originalJson = res.json.bind(res)
  res.json = ((body: any) => {
    const options = Array.isArray(body?.shipping_options)
      ? body.shipping_options
      : null
    if (!options) {
      return originalJson(body)
    }

    // Only zip/city-restricted options need a Strapi check; everything else
    // always passes. If none are restricted, emit immediately (no await).
    const restricted = options.filter((option: any) => {
      const serviceCode = resolveServiceCodeFromMethod(option)
      return ZIP_RESTRICTED_SERVICE_CODES.has(serviceCode) && option?.id
    })
    if (restricted.length === 0) {
      return originalJson(body)
    }

    Promise.all(
      restricted.map(async (option: any) => {
        const serviceCode = resolveServiceCodeFromMethod(option)
        try {
          const ok = await isDestinationServiceable(
            serviceCode,
            shippingAddress
          )
          return [option.id as string, ok] as const
        } catch {
          // Fail open per option.
          return [option.id as string, true] as const
        }
      })
    )
      .then((entries) => {
        const verdicts = new Map<string, boolean>(entries)
        const filtered = options.filter((option: any) => {
          const serviceCode = resolveServiceCodeFromMethod(option)
          if (!ZIP_RESTRICTED_SERVICE_CODES.has(serviceCode)) return true
          // Default to serviceable (fail open) if a verdict is somehow missing.
          const verdict = option?.id ? verdicts.get(option.id) : undefined
          return verdict !== false
        })
        originalJson({ ...body, shipping_options: filtered })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(
          `[shipping-options-filter] serviceability check failed for cart ${cartId} (${message}); returning all options`
        )
        emitGuardFailureAlert({
          logger,
          alertKind: "mw_shipping_options_filter_failed",
          severity: "warn",
          title: "middleware: shipping-options serviceability check failed",
          error,
        })
        originalJson(body)
      })

    return res
  }) as typeof res.json

  return next()
}

// LAYER 1 (synchronous front-line self-heal): before any cart-mutation route
// that RE-PRICES the cart's selected shipping methods runs its core handler,
// remove any zip/city-restricted method (Metro Atlanta Delivery / Scheduled
// Delivery) whose service area no longer covers the cart's EFFECTIVE ship-to
// address. This makes the heal synchronous: the triggering request itself
// succeeds because refreshCartShippingMethodsWorkflow never sees the stale
// method and so never tries to re-price (and throw on) it.
//
// Two cases this covers:
//  1) "change address out of zone" — the request body carries a NEW shipping
//     address; we must validate against that new address (it is what the cart
//     will have after this mutation), not the stale current address.
//  2) "add/remove a line item while a stale bad method sits on the cart" — no
//     new address in the body; we validate against the cart's CURRENT address.
//
// Layers 2 (cart.updated subscriber) and 3 (GET /store/shipping-options filter)
// remain as backstops: Layer 3 keeps an unserviceable option from being offered,
// Layer 2 catches non-API cart.updated events. This Layer 1 is the request-path
// front-line so the customer never even sees one error.
//
// Fail open: ANY error in here proceeds to next() unchanged. A failure to heal
// must never block a cart mutation.

type EffectiveAddress = {
  postal_code?: string | null
  city?: string | null
  province?: string | null
}

/**
 * Pull a shipping address out of a cart-mutation request body, if one is
 * present. Two shapes are supported:
 *   - nested: `req.body.shipping_address` (POST /store/carts/:id with an address)
 *   - flat:   `req.body` itself carrying postal_code/city (some address-update
 *             call shapes)
 * Returns null when the body carries no postal_code (so the caller falls back to
 * the cart's current address).
 */
export function extractAddressFromBody(body: unknown): EffectiveAddress | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, any>

  const nested = b.shipping_address
  if (
    nested &&
    typeof nested === "object" &&
    typeof nested.postal_code === "string" &&
    nested.postal_code.trim()
  ) {
    return {
      postal_code: nested.postal_code,
      city: typeof nested.city === "string" ? nested.city : null,
      province: typeof nested.province === "string" ? nested.province : null,
    }
  }

  // Flat address-update shape: the body itself is the address.
  if (typeof b.postal_code === "string" && b.postal_code.trim()) {
    return {
      postal_code: b.postal_code,
      city: typeof b.city === "string" ? b.city : null,
      province: typeof b.province === "string" ? b.province : null,
    }
  }

  return null
}

/**
 * Resolve the cart id from a cart-mutation request. Prefers the route param
 * `id`, then `cart_id`, then parses it out of the request path
 * (/store/carts/<cartId>[/...]).
 */
export function resolveCartIdFromRequest(req: {
  params?: Record<string, any>
  originalUrl?: string
  url?: string
  path?: string
}): string | null {
  const fromParams =
    (req.params?.id as string | undefined) ||
    (req.params?.cart_id as string | undefined)
  if (typeof fromParams === "string" && fromParams.trim()) {
    return fromParams.trim()
  }

  const path = staffRequestPath(req)
  const match = path.match(/\/store\/carts\/([^/?]+)/)
  if (match?.[1]) {
    return decodeURIComponent(match[1])
  }

  return null
}

/**
 * Core, harness-free logic for the synchronous self-heal. Exported for unit
 * testing: it takes the resolved scope + request shape and returns the list of
 * shipping-method ids it removed (so a test can assert without the full Medusa
 * HTTP middleware stack). NEVER throws — it logs and returns [] on any failure.
 */
export async function dropUnserviceableShippingMethods(req: {
  scope: { resolve: (key: string) => any }
  params?: Record<string, any>
  originalUrl?: string
  url?: string
  path?: string
  body?: unknown
}): Promise<string[]> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const cartId = resolveCartIdFromRequest(req)
    if (!cartId) {
      return []
    }

    return await req.scope.resolve(Modules.LOCKING).execute(
      cartId,
      async () => {
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "cart",
          fields: [
            "id",
            "completed_at",
            "shipping_address.postal_code",
            "shipping_address.city",
            "shipping_address.province",
            "shipping_methods.id",
            "shipping_methods.name",
            "shipping_methods.data",
            "shipping_methods.shipping_option_id",
            "shipping_methods.shipping_option.name",
            "shipping_methods.shipping_option.data",
          ],
          filters: { id: cartId },
        })

        const cart = data?.[0] as any
        if (!cart || cart.completed_at) {
          return []
        }

        const methods: any[] = Array.isArray(cart.shipping_methods)
          ? cart.shipping_methods
          : []
        if (methods.length === 0) {
          return []
        }

        // Effective address: a NEW address in the request body wins (covers the
        // "change address out of zone" case); otherwise the cart's CURRENT address.
        const effectiveAddress: EffectiveAddress | null =
          extractAddressFromBody(req.body) || cart.shipping_address || null

        const invalidMethodIds: string[] = []
        for (const method of methods) {
          const serviceCode = resolveServiceCodeFromMethod(method)
          // Fast path: only restricted services can be unserviceable — skip the
          // Strapi round-trip for everything else (UPS / pickup / unknown).
          if (!ZIP_RESTRICTED_SERVICE_CODES.has(serviceCode)) continue

          const serviceable = await isDestinationServiceable(
            serviceCode,
            effectiveAddress
          )
          if (!serviceable && method?.id) {
            invalidMethodIds.push(method.id)
          }
        }

        if (invalidMethodIds.length === 0) {
          return []
        }

        const cartModuleService = req.scope.resolve(Modules.CART)
        await cartModuleService.deleteShippingMethods(invalidMethodIds)

        logger.info(
          `[cart-shipping-presync] removed ${
            invalidMethodIds.length
          } unserviceable shipping method(s) from cart ${cartId} before re-price: ${invalidMethodIds.join(
            ", "
          )}`
        )

        return invalidMethodIds
      },
      { timeout: 30 }
    )
  } catch (error) {
    // Fail open: a heal failure must never block the cart mutation.
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      `[cart-shipping-presync] synchronous heal failed; proceeding with mutation: ${message}`
    )
    emitGuardFailureAlert({
      logger,
      alertKind: "mw_drop_unserviceable_methods_failed",
      severity: "warn",
      title: "middleware: drop-unserviceable-shipping-methods heal failed",
      error,
    })
    return []
  }
}

/**
 * Express-style middleware wrapper. AWAITS the heal before calling next() so the
 * subsequent core re-price never observes the stale method (this is what makes
 * the self-heal synchronous). ALWAYS calls next(); never blocks the mutation.
 */
async function dropUnserviceableShippingMethodsBeforeMutation(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    await dropUnserviceableShippingMethods(req as any)
  } catch {
    // dropUnserviceableShippingMethods already fails open internally; this is a
    // belt-and-suspenders guard so a wrapper-level throw can never block next().
  }
  return next()
}

export default defineMiddlewares({
  // Global error handler: alerts on unexpected server failures (paging only
  // for an explicit money-mutation allowlist), suppresses expected client 4xx
  // noise, then DELEGATES to Medusa's core handler so the response is unchanged.
  // See ./middlewares/ops-error-handler.ts.
  errorHandler: opsErrorHandler,
  routes: [
    { matcher: "/store/carts*", middlewares: [enforceStaffCartAuthority] },
    {
      matcher: "/store/payment-collections*",
      middlewares: [enforceStaffCartAuthority],
    },
    {
      matcher: "/store/grillers/checkout/*",
      method: "POST",
      middlewares: [enforceStaffCartAuthority],
    },
    {
      matcher: "/store/gp-inventory/resolution",
      method: "POST",
      middlewares: [enforceStaffCartAuthority],
    },
    { matcher: "/store/products", method: ["GET"], middlewares: [filterPublicCatalog] },
    { matcher: "/store/products/:id", method: ["GET"], middlewares: [filterPublicCatalog] },
    { matcher: "/store/carts", method: ["POST"], middlewares: [guardNewCartItems] },
    { matcher: "/store/carts/:id/line-items/:line_id", method: ["POST"], middlewares: [guardUpdatedCartItem] },
    { matcher: "/store/carts/:id/complete", method: ["POST"], middlewares: [guardCompletedCart] },
    { matcher: "/store/payment-collections", method: ["POST"], middlewares: [guardCompletedCart] },
    { matcher: "/store/payment-collections/:id/payment-sessions", method: ["POST"], middlewares: [guardCartPaymentSession] },
    { matcher: "/store/grillers/checkout/place-order", method: ["POST"], middlewares: [guardCompletedCart] },
    { matcher: "/store/gp-inventory/availability", method: ["POST"], middlewares: [guardInventoryVariants] },
    { matcher: "/store/gp-inventory/resolution", method: ["POST"], middlewares: [guardInventoryResolution] },
    {
      matcher: "/admin/*",
      middlewares: [
        authenticateAdminExceptInvite,
        enforceStaffCapabilitiesExceptInvite,
      ],
    },
    {
      matcher: "/auth/token/refresh",
      method: "POST",
      middlewares: [
        authenticate("*", ["bearer"], { allowUnregistered: true }),
        enforceStaffSessionEpoch,
      ],
    },
    {
      matcher: "/auth/session",
      method: "POST",
      middlewares: [authenticate("*", ["bearer"]), enforceStaffSessionEpoch],
    },
    {
      matcher: "/store/customers/me",
      method: "GET",
      middlewares: [
        authenticate("customer", ["session", "bearer"]),
        publishCurrentStaffAccess,
      ],
    },
    {
      matcher: "/admin/customers",
      method: "POST",
      middlewares: [protectAdminCustomerAuthority],
    },
    {
      matcher: "/admin/customers/:id",
      method: "POST",
      middlewares: [protectAdminCustomerAuthority],
    },
    {
      matcher: "/admin/customers/:id/addresses*",
      method: ["POST", "DELETE"],
      middlewares: [protectAdminCustomerAuthority],
    },
    {
      matcher: "/admin/customers*",
      method: "GET",
      middlewares: [publishAdminStaffAccess],
    },
    {
      matcher: "/store/customers",
      method: ["POST"],
      middlewares: [protectCustomerStaffAuthority],
    },
    {
      matcher: "/store/customers/me",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"]), protectCustomerStaffAuthority],
    },
    {
      matcher: "/store/customers/me/receipt-email",
      method: ["GET", "POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/customers/me/institutional-terms",
      method: "GET",
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/carts/:id/complete",
      method: ["POST"],
      middlewares: [
        authenticate("customer", ["session", "bearer"], {
          allowUnauthenticated: true,
        }),
      ],
    },
    { matcher: "/store/*", middlewares: [hideShippingInternals] },
    {
      matcher: "/store/carts/:id/order-review",
      method: ["GET", "POST"],
      middlewares: [
        authenticate("customer", ["session", "bearer"], {
          allowUnauthenticated: true,
        }),
      ],
    },
    {
      matcher: "/store/shipping-options",
      method: ["GET"],
      middlewares: [filterUnserviceableShippingOptions],
    },
    // LAYER 1 (synchronous front-line): drop unserviceable methods BEFORE the
    // cart-mutation core handlers that re-price shipping. :param matchers are
    // confirmed supported in this Medusa version (see /admin/orders/:id/... and
    // /store/carts/:id/line-items registrations below).
    {
      matcher: "/store/carts/:id",
      method: ["POST"],
      middlewares: [dropUnserviceableShippingMethodsBeforeMutation],
    },
    {
      matcher: "/store/carts/:id/line-items/:line_id",
      method: ["POST", "DELETE"],
      middlewares: [dropUnserviceableShippingMethodsBeforeMutation],
    },
    {
      matcher: "/store/legacy-order-history/*",
      method: ["GET", "POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/customers/me/contact",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/customers/me",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"]), guardCustomerContactWrite],
    },
    {
      matcher: "/store/customers",
      method: ["POST"],
      middlewares: [guardCustomerProvenanceCreate],
    },
    {
      matcher: "/store/customers/me/password",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/payment-methods*",
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/grillers/checkout*",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      // #291: self-serve B2B "pay by invoice" application intake.
      matcher: "/store/grillers/invoice-applications*",
      method: ["POST"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      // Marketing SMS state is customer-private and must be read from the
      // communications source of truth, never from caller-supplied identity.
      matcher: "/store/grillers/communications/sms-marketing-status",
      method: ["GET"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/carts/:id/line-items",
      method: ["POST"],
      // Establish eligibility before any shipping/cart mutation.
      middlewares: [
        guardAddedCartItem,
        dropUnserviceableShippingMethodsBeforeMutation,
      ],
    },
    {
      matcher: "/admin/legacy-orders*",
      method: ["GET"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/legacy-order-history/*",
      method: ["GET", "POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/legacy-reorder-requests*",
      method: ["GET", "POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/legacy-item-mapping-candidates*",
      method: ["GET", "POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/grillers/payments*",
      method: ["POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/grillers/inventory*",
      method: ["GET", "POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/grillers/finalization*",
      method: ["GET", "POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      // #277: staff "Create a customer account" surface.
      matcher: "/admin/grillers/customers*",
      method: ["POST"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    {
      matcher: "/admin/grillers/orders/*/finalization*",
      method: ["GET", "POST", "PATCH"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    // Both fulfillment gates run on every fulfillment-creating route, in order:
    // (1) the final-charge money gate, then (2) the advisory Slack-hold gate.
    // They are independent — either can short-circuit with an error and the other
    // never runs after a sent response.
    {
      matcher: "/admin/orders/:id/fulfillments",
      method: ["POST"],
      middlewares: [
        bindFulfillmentAudit,
        blockFulfillmentBeforeFinalCharge,
        blockFulfillmentOnSlackHold,
      ],
    },
    {
      matcher: "/admin/orders/:id/fulfillments/*/shipments",
      method: ["POST"],
      middlewares: [
        bindFulfillmentAudit,
        blockFulfillmentBeforeFinalCharge,
        blockFulfillmentOnSlackHold,
      ],
    },
    {
      matcher: "/admin/fulfillments",
      method: ["POST"],
      middlewares: [
        bindFulfillmentAudit,
        blockFulfillmentBeforeFinalCharge,
        blockFulfillmentOnSlackHold,
      ],
    },
    {
      // Medusa's native Stripe provider webhook. Validate its endpoint-specific
      // signing secret before the built-in route acknowledges and queues work.
      matcher: "/hooks/payment/stripe_stripe",
      method: ["POST"],
      middlewares: [verifyNativeStripeWebhookSignature],
      bodyParser: { preserveRawBody: true },
    },
    {
      // Stripe webhook (payment_intent.payment_failed). Not under /admin or
      // /store, so it bypasses customer/user auth; preserve the raw body so the
      // route can verify the Stripe-Signature HMAC over the exact bytes.
      matcher: "/webhooks/stripe/payment-failed",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      // Slack `/gp` slash-command query bot. Outside /admin and /store, so it
      // bypasses Medusa auth; the Slack signing secret is the ONLY gate. Slack
      // sends application/x-www-form-urlencoded, so preserve the raw body — it
      // is needed for BOTH the X-Slack-Signature HMAC and the payload parse.
      matcher: "/webhooks/slack/command",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      // Slack interactivity endpoint (on-call "✅ Ack" button). Outside /admin
      // and /store so it bypasses Medusa auth — the Slack signing secret is the
      // ONLY gate. Slack sends application/x-www-form-urlencoded with a single
      // `payload` field, so preserve the raw body for the X-Slack-Signature HMAC
      // (verified over the exact bytes) and the payload parse.
      matcher: "/webhooks/slack/interactivity",
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
  ],
})
