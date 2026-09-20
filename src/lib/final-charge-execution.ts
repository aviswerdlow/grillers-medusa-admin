import {
  FINALIZATION_CHARGE_ATTEMPTING,
  FINALIZATION_CHARGE_FAILED_HOLD,
  FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED,
  FINALIZATION_CHARGED_READY_TO_SHIP,
  FINALIZATION_PACKED_PENDING_CHARGE,
  appendStaffAudit,
  assertStripeFinalPaymentIntentSucceeded,
  claimFinalChargeAttempt,
  createStripeFinalPaymentIntent,
  finalChargeAttemptIdempotencyKey,
  finalChargeOrderMetadata,
  finalChargeSucceeded,
  finalizedCatchWeightOrderMetadata,
  isInvoiceOrder,
  metadataObject,
  previewFinalization,
  retrieveStripeFinalPaymentIntent,
  settleFinalChargeAttempt,
  type CatchWeightDb,
} from "./catch-weight-finalization"
import {
  bookWwexFinalizationShipment,
  quoteWwexFinalizationShipping,
} from "./wwex-finalization-shipment"
import {
  emitChargeFailedHoldAlert,
  emitChargeMarkedReadyButPiNotSucceededAlert,
  emitFinalChargeNonSucceededAlert,
} from "./final-charge-ops-alerts"

/**
 * The single hardened final-charge path. This is the exact orchestration the
 * charge-and-release admin route runs, extracted verbatim so it can be shared by
 * BOTH the manual route AND the fixed-price auto-charge trigger (subscriber). It
 * MUST remain the only place a final card charge is executed — never reimplement
 * the Stripe charge, the stable idempotency key, the adopt-not-recharge decision,
 * the early PaymentIntent persist, or the succeeded-recording-failed handling.
 *
 * It performs no res/req work: callers translate the returned outcome into an
 * HTTP response (route) or a log line (subscriber).
 */

const stripeChargeId = (paymentIntent: {
  latest_charge?: string | null
  charges?: { data?: Array<{ id?: string }> }
}) =>
  paymentIntent.latest_charge || paymentIntent.charges?.data?.[0]?.id || null

// Stable per (order, finalization, confirmed-decline generation) — the linchpin
// double-charge protection. The generation stays at zero through timeouts,
// unknown outcomes, recording failures, and concurrent replays. It advances
// only after Stripe has identified a genuine declined PaymentIntent.
export const stableFinalChargeIdempotencyKey = (
  orderId: string,
  finalizationId: string,
  confirmedDeclineCount = 0
) =>
  finalChargeAttemptIdempotencyKey(
    `final-charge:${orderId}:${finalizationId}`,
    confirmedDeclineCount
  )

export const isConfirmedStripeFinalChargeDecline = (
  stripeError: Record<string, any> | null | undefined
) => {
  const paymentIntent = stripeError?.payment_intent || {}
  const lastPaymentError = paymentIntent.last_payment_error || {}
  return Boolean(
    paymentIntent.id &&
      paymentIntent.status === "requires_payment_method" &&
      (stripeError?.code === "card_declined" ||
        lastPaymentError.code === "card_declined")
  )
}

export type FinalChargeServices = {
  db: CatchWeightDb
  orderModule: {
    listOrderTransactions: (...args: any[]) => Promise<any[]>
    addOrderTransactions: (...args: any[]) => Promise<any>
    updateOrders: (...args: any[]) => Promise<any>
  }
  eventBus: { emit: (...args: any[]) => Promise<any> }
  logger: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

export type FinalChargeOutcomeResult =
  | "invoice_order"
  | "already_charged"
  | "preflight_rejected"
  | "preflight_exception"
  | "charge_in_progress"
  | "charged"
  | "charge_failed"
  | "charge_recording_failed"

export type FinalChargeOutcome = {
  result: FinalChargeOutcomeResult
  status: number
  body: Record<string, any>
  // Only set for preflight_exception: the route emits the req-scoped failure alert.
  preflightError?: unknown
}

export async function runFinalChargeAndRelease(
  services: FinalChargeServices,
  order: Record<string, any>,
  input: { staffAudit: Record<string, any>; staffActor: string | null }
): Promise<FinalChargeOutcome> {
  const { db, orderModule, eventBus, logger } = services
  const { staffAudit, staffActor } = input

  // #283: invoice (A/R) orders are never card-charged. Refuse before any card-status logic so an
  // invoice order is neither stranded in nor accidentally routed through the card-charge path.
  if (isInvoiceOrder(order)) {
    return {
      result: "invoice_order",
      status: 409,
      body: {
        message:
          "This is a pay-by-invoice order. It bills to accounts receivable and is not charged to a card; it releases to fulfillment once packed.",
      },
    }
  }

  if (finalChargeSucceeded(order)) {
    return {
      result: "already_charged",
      status: 200,
      body: {
        already_charged: true,
        order,
        metadata: metadataObject(order.metadata),
      },
    }
  }

  let preview: Awaited<ReturnType<typeof previewFinalization>>
  let wwexQuote: Awaited<ReturnType<typeof quoteWwexFinalizationShipping>>
  let effectiveTotals: Record<string, any>
  let finalOrderTotal: number
  let chargeAmount: number
  let chargeCurrencyCode: string
  let idempotencyKey: string
  let paymentIntent: Awaited<
    ReturnType<typeof createStripeFinalPaymentIntent>
  > | null = null
  let persistedPaymentIntentId: string | null = null
  let persistedChargeId: string | null = null
  let attempt!: Record<string, any>
  let mayAdoptPersistedFinalizationPaymentIntent = false

  try {
    preview = await previewFinalization(db, order, {
      persist: true,
      // Charging must validate the status staff actually approved. A normal
      // persisted preview promotes clean packing work to packed_pending_charge;
      // doing that here would erase charge_attempting/failed/recovery state
      // before the attempt claim can make its concurrency decision.
      preserveWorkflowStatus: true,
    })

    if (preview.errors.length) {
      return {
        result: "preflight_rejected",
        status: 409,
        body: {
          message: "Finalization has unresolved line errors.",
          errors: preview.errors,
        },
      }
    }

    if (
      preview.finalization.status !== FINALIZATION_PACKED_PENDING_CHARGE &&
      preview.finalization.status !== FINALIZATION_CHARGE_FAILED_HOLD &&
      preview.finalization.status !==
        FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED &&
      preview.finalization.status !== FINALIZATION_CHARGE_ATTEMPTING
    ) {
      return {
        result: "preflight_rejected",
        status: 409,
        body: {
          message:
            "Order must be approved before the final charge can be attempted.",
          status: preview.finalization.status,
        },
      }
    }

    if (!preview.payment_setup?.stripe_payment_method_id) {
      return {
        result: "preflight_rejected",
        status: 409,
        body: { message: "Order does not have a saved Stripe card." },
      }
    }

    if (!preview.payment_setup?.stripe_customer_id) {
      return {
        result: "preflight_rejected",
        status: 409,
        body: { message: "Order does not have a Stripe customer id." },
      }
    }

    // A carrier outage must not prevent recording a payment that already
    // succeeded. The existing A1 recovery path below must retrieve the known
    // PaymentIntent and refuses to create a replacement when its ID is absent.
    const recordingSettledPayment =
      preview.finalization.status ===
        FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED ||
      metadataObject(order.metadata).final_charge_status ===
        "succeeded_recording_failed"
    wwexQuote = recordingSettledPayment
      ? null
      : await quoteWwexFinalizationShipping({ order, preview, logger })
    if (wwexQuote?.status === "blocked") {
      return {
        result: "preflight_rejected",
        status: 409,
        body: {
          message:
            "Shipping needs review before the final charge. No new charge was attempted.",
          type: wwexQuote.reason,
        },
      }
    }
    effectiveTotals = wwexQuote?.totals || preview.totals

    finalOrderTotal = effectiveTotals.final_order_total
    if (finalOrderTotal === null || finalOrderTotal === undefined) {
      return {
        result: "preflight_rejected",
        status: 409,
        body: {
          message:
            "Final order total is not available until all catch-weight lines are complete.",
        },
      }
    }

    const attemptClaim = await claimFinalChargeAttempt(db, {
      orderId: order.id,
      finalizationId: preview.finalization.id,
      finalizationStatus: preview.finalization.status,
      amount: finalOrderTotal,
      currencyCode:
        preview.finalization.currency_code || order.currency_code || "usd",
      stripeCustomerId: preview.payment_setup.stripe_customer_id,
      stripePaymentMethodId: preview.payment_setup.stripe_payment_method_id,
      baseIdempotencyKey: stableFinalChargeIdempotencyKey(
        order.id,
        preview.finalization.id
      ),
      requestedBy: staffActor,
    })
    attempt = attemptClaim.attempt
    idempotencyKey = String(attempt.idempotency_key || "").trim()
    if (!idempotencyKey) {
      throw new Error(
        "Final charge attempt is missing its Stripe idempotency key."
      )
    }
    if (!attemptClaim.claimed) {
      return {
        result: "charge_in_progress",
        status: 409,
        body: {
          message:
            "A final card charge is already in progress or has just settled. Refresh the order before retrying.",
          charge_attempt_id: attempt.id,
          payment_intent_id: attempt.stripe_payment_intent_id || null,
        },
      }
    }
    const attemptedAmount = Number(attempt.amount)
    chargeAmount = Number.isFinite(attemptedAmount)
      ? attemptedAmount
      : finalOrderTotal
    chargeCurrencyCode = String(
      attempt.currency_code ||
        preview.finalization.currency_code ||
        order.currency_code ||
        "usd"
    )
    const orderMetadata = metadataObject(order.metadata)
    const recoveringRecordedPaymentIntent =
      preview.finalization.status ===
        FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED ||
      orderMetadata.final_charge_status === "succeeded_recording_failed"
    const previousFinalizationAttemptId = String(
      preview.finalization.charge_attempt_id || ""
    ).trim()
    const confirmedDeclineGeneration = Number(
      metadataObject(attempt.metadata).confirmed_decline_generation || 0
    )
    mayAdoptPersistedFinalizationPaymentIntent =
      recoveringRecordedPaymentIntent ||
      previousFinalizationAttemptId === String(attempt.id) ||
      confirmedDeclineGeneration === 0
    const attemptPaymentIntentId = String(
      attempt.stripe_payment_intent_id || ""
    ).trim()
    const persistedFinalizationPaymentIntentId =
      mayAdoptPersistedFinalizationPaymentIntent
        ? String(
            preview.finalization.stripe_payment_intent_id ||
              (recoveringRecordedPaymentIntent
                ? orderMetadata.stripe_payment_intent_id
                : "") ||
              ""
          ).trim()
        : ""

    await db("gp_order_finalization")
      .where({ id: preview.finalization.id })
      .update({
        status: FINALIZATION_CHARGE_ATTEMPTING,
        charge_attempt_id: attempt.id,
        charge_attempted_at: new Date(),
        charged_by: staffActor,
        // A fresh post-decline generation must not inherit the prior declined
        // PI. Every other recovery keeps a known PI durably linked to the
        // claimed attempt so a later replay adopts it instead of re-charging.
        stripe_payment_intent_id:
          attemptPaymentIntentId ||
          persistedFinalizationPaymentIntentId ||
          null,
        stripe_charge_id:
          attempt.stripe_charge_id ||
          (mayAdoptPersistedFinalizationPaymentIntent
            ? preview.finalization.stripe_charge_id
            : null) ||
          null,
        updated_at: new Date(),
      })
  } catch (error) {
    return {
      result: "preflight_exception",
      status: 409,
      body: {
        message:
          error instanceof Error
            ? error.message
            : "Could not prepare the final charge.",
      },
      preflightError: error,
    }
  }

  try {
    const orderMetadata = metadataObject(order.metadata)
    const shouldRecoverRecordedPaymentIntent =
      preview.finalization.status ===
        FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED ||
      orderMetadata.final_charge_status === "succeeded_recording_failed"
    const existingPaymentIntentId = String(
      attempt.stripe_payment_intent_id ||
        (mayAdoptPersistedFinalizationPaymentIntent
          ? preview.finalization.stripe_payment_intent_id ||
            (shouldRecoverRecordedPaymentIntent
              ? orderMetadata.stripe_payment_intent_id
              : "")
          : "") ||
        ""
    ).trim()
    if (existingPaymentIntentId) {
      // Any durable PI identity turns a retry into reconciliation. This covers
      // processing/unknown outcomes as well as the explicit
      // succeeded-recording-failed recovery state. Never create a second PI
      // while an unresolved one is known.
      persistedPaymentIntentId = existingPaymentIntentId
      paymentIntent = await retrieveStripeFinalPaymentIntent(
        existingPaymentIntentId
      )
    } else {
      paymentIntent = await createStripeFinalPaymentIntent({
        amount: chargeAmount,
        currencyCode: chargeCurrencyCode,
        stripeCustomerId:
          attempt.stripe_customer_id ||
          preview.payment_setup.stripe_customer_id,
        stripePaymentMethodId:
          attempt.stripe_payment_method_id ||
          preview.payment_setup.stripe_payment_method_id,
        idempotencyKey,
        orderId: order.id,
        finalizationId: preview.finalization.id,
        displayId: (order as any).display_id
          ? String((order as any).display_id)
          : null,
      })
    }
    persistedPaymentIntentId = paymentIntent.id
    persistedChargeId = stripeChargeId(paymentIntent)
    await db("gp_order_finalization")
      .where({ id: preview.finalization.id })
      .update({
        stripe_payment_intent_id: persistedPaymentIntentId,
        stripe_charge_id: persistedChargeId,
        stripe_failure_code: null,
        stripe_failure_message: null,
        updated_at: new Date(),
      })
    if (paymentIntent.status && paymentIntent.status !== "succeeded") {
      // #251: non-succeeded Stripe intents must be visible before the assert trips.
      await emitFinalChargeNonSucceededAlert({
        logger,
        orderId: order.id,
        finalizationId: preview.finalization.id,
        paymentIntentId: paymentIntent.id,
        paymentIntentStatus: paymentIntent.status,
        amount: chargeAmount,
      })
      // MONEY-CRITICAL guard (Section A): the order is about to be marked
      // charged_ready_to_ship (lifts fulfillment gate + queues QBD invoice +
      // emails customer) but the PaymentIntent has NOT settled. The existing
      // assert below ALWAYS blocks this transition by throwing, so the behavior
      // here is already "blocked". GRILLERS_BLOCK_NONSUCCEEDED_CHARGE (default
      // false) exists for the inverse, opt-in scenario where the assert is ever
      // relaxed: if set true it forces the block to remain; if false and the
      // assert were ever removed, this would degrade to alert-only. We do NOT
      // change control flow here beyond the alert — the assert is the gate.
      const blockNonSucceeded =
        process.env.GRILLERS_BLOCK_NONSUCCEEDED_CHARGE === "true"
      // The assert below trips unconditionally, so the transition is blocked
      // regardless of the flag. `assertEnforcesBlock` documents that; the flag
      // is folded in so the reported value stays accurate if the assert is ever
      // relaxed in favor of the opt-in flag.
      const assertEnforcesBlock = true
      await emitChargeMarkedReadyButPiNotSucceededAlert({
        logger,
        orderId: order.id,
        finalizationId: preview.finalization.id,
        paymentIntentId: paymentIntent.id,
        paymentIntentStatus: paymentIntent.status,
        amount: chargeAmount,
        blocked: assertEnforcesBlock || blockNonSucceeded,
      })
    }
    assertStripeFinalPaymentIntentSucceeded(paymentIntent)
    const chargeId = stripeChargeId(paymentIntent)
    attempt = await settleFinalChargeAttempt(db, attempt, {
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: chargeId,
      stripeStatus: paymentIntent.status || null,
      status: "succeeded",
    })
    if (attempt.claim_lost === true) {
      return {
        result: "charge_in_progress",
        status: 409,
        body: {
          message:
            "A newer caller owns this shared Stripe attempt and is recording its result. Refresh the order; do not retry the customer charge.",
          charge_attempt_id: attempt.id,
          payment_intent_id: attempt.stripe_payment_intent_id || null,
        },
      }
    }

    const finalizationForMetadata = {
      ...preview.finalization,
      ...effectiveTotals,
      status: FINALIZATION_CHARGED_READY_TO_SHIP,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_charge_id: chargeId,
    }

    const wwexBooking = await bookWwexFinalizationShipment({
      order,
      quote: wwexQuote,
      logger,
    })

    await db("gp_order_finalization")
      .where({ id: preview.finalization.id })
      .update({
        ...effectiveTotals,
        status: FINALIZATION_CHARGED_READY_TO_SHIP,
        charged_at: new Date(),
        charged_by: staffActor,
        charge_attempt_id: attempt.id,
        released_at: new Date(),
        released_by: staffActor,
        stripe_payment_intent_id: paymentIntent.id,
        stripe_charge_id: chargeId,
        stripe_failure_code: null,
        stripe_failure_message: null,
        qbd_posting_required: true,
        qbd_posting_status: "pending_manual",
        qbd_posting_action: "final_card_charge_accounting_record",
        qbd_posting_request_key: `final_charge:${paymentIntent.id}`,
        metadata: {
          ...metadataObject(preview.finalization.metadata),
          ...(wwexQuote?.metadata || {}),
          ...(wwexBooking.metadata || {}),
        },
        updated_at: new Date(),
      })

    const existingTransactions = await orderModule.listOrderTransactions(
      {
        order_id: order.id,
        reference: "final_charge",
        reference_id: paymentIntent.id,
      },
      { select: ["id"] }
    )

    if (!existingTransactions.length) {
      await orderModule.addOrderTransactions({
        order_id: order.id,
        amount: chargeAmount,
        currency_code: chargeCurrencyCode,
        reference: "final_charge",
        reference_id: paymentIntent.id,
      })
    }

    const metadata = {
      ...finalChargeOrderMetadata({
        order,
        finalization: finalizationForMetadata,
        paymentIntent,
        attemptId: attempt.id,
        actorId: staffActor,
        staffAudit,
      }),
      ...(wwexQuote?.metadata || {}),
      ...(wwexBooking.metadata || {}),
      ...finalizedCatchWeightOrderMetadata({
        order,
        lines: preview.lines,
        packages: preview.packages,
      }),
    }

    await orderModule.updateOrders(order.id, { metadata })
    await eventBus.emit({
      name: "order.final_charge_succeeded",
      data: {
        id: order.id,
        order_id: order.id,
        finalization_id: preview.finalization.id,
        payment_intent_id: paymentIntent.id,
        amount: chargeAmount,
        currency_code: chargeCurrencyCode,
      },
    })

    return {
      result: "charged",
      status: 200,
      body: {
        order,
        finalization: finalizationForMetadata,
        lines: preview.lines,
        package_capture_required: preview.package_capture_required,
        packages: preview.packages,
        payment_setup: preview.payment_setup,
        charge_attempt: attempt,
        payment_intent: {
          id: paymentIntent.id,
          status: paymentIntent.status,
          latest_charge: chargeId,
        },
        metadata,
      },
    }
  } catch (error) {
    const stripeError = (error as any)?.stripe_error || {}
    const succeededPaymentIntent =
      paymentIntent?.status === "succeeded" ? paymentIntent : null
    const failureMessage =
      error instanceof Error ? error.message : "Stripe final charge failed."
    const confirmedStripeDecline =
      !succeededPaymentIntent &&
      isConfirmedStripeFinalChargeDecline(stripeError)
    attempt = await settleFinalChargeAttempt(db, attempt, {
      stripePaymentIntentId:
        persistedPaymentIntentId || stripeError.payment_intent?.id || null,
      stripeChargeId:
        persistedChargeId || stripeChargeId(stripeError.payment_intent || {}),
      stripeStatus:
        paymentIntent?.status || stripeError.payment_intent?.status || null,
      status: succeededPaymentIntent ? "succeeded" : "failed",
      failureCode: succeededPaymentIntent ? null : stripeError.code || null,
      failureMessage: succeededPaymentIntent ? null : failureMessage,
      metadata: confirmedStripeDecline
        ? {
            confirmed_stripe_decline: true,
            stripe_error_type: stripeError.type || null,
            stripe_decline_code:
              stripeError.decline_code ||
              stripeError.payment_intent?.last_payment_error?.decline_code ||
              null,
          }
        : undefined,
    })

    if (
      attempt.claim_lost === true ||
      (!succeededPaymentIntent && attempt.status === "succeeded")
    ) {
      // A concurrent replay has already verified this shared attempt as
      // succeeded, or a stale caller has lost its attempt lease. Do not let
      // this caller race or downgrade the owner recording the release.
      return {
        result: "charge_in_progress",
        status: 409,
        body: {
          message:
            "The shared Stripe attempt is owned by a newer caller or already succeeded and is being reconciled. Refresh the order; do not retry the customer charge.",
          charge_attempt_id: attempt.id,
          payment_intent_id: attempt.stripe_payment_intent_id || null,
        },
      }
    }
    const failedStatus = succeededPaymentIntent
      ? FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED
      : FINALIZATION_CHARGE_FAILED_HOLD
    const failedChargeStatus = succeededPaymentIntent
      ? "succeeded_recording_failed"
      : "failed"
    const failedGateStatus = succeededPaymentIntent
      ? "blocked_charge_succeeded_recording_failed"
      : "blocked_charge_failed"
    const eventAt = new Date().toISOString()
    const metadata = appendStaffAudit(
      {
        ...metadataObject(order.metadata),
        finalization_id: preview.finalization.id,
        finalization_status: failedStatus,
        catch_weight_status: failedStatus,
        final_charge_status: failedChargeStatus,
        ...(succeededPaymentIntent ? {} : { final_charge_failed_at: eventAt }),
        ...(succeededPaymentIntent
          ? { final_charge_recording_failed_at: eventAt }
          : {}),
        fulfillment_gate_status: failedGateStatus,
        stripe_payment_intent_id:
          persistedPaymentIntentId || stripeError.payment_intent?.id || null,
        stripe_charge_id:
          persistedChargeId || stripeChargeId(stripeError.payment_intent || {}),
        stripe_failure_code: succeededPaymentIntent
          ? null
          : stripeError.code || null,
        stripe_failure_message: succeededPaymentIntent ? null : failureMessage,
        final_charge_recording_failure_message: succeededPaymentIntent
          ? failureMessage
          : undefined,
      },
      {
        action: succeededPaymentIntent
          ? "final_charge_succeeded_recording_failed"
          : "final_charge_failed",
        status: failedStatus,
        charge_attempt_id: attempt.id,
        ...staffAudit,
        payment_intent_id:
          persistedPaymentIntentId || stripeError.payment_intent?.id || null,
        failure_code: succeededPaymentIntent ? null : stripeError.code || null,
        failure_message: failureMessage,
      }
    )

    await db("gp_order_finalization")
      .where({ id: preview.finalization.id })
      .update({
        status: failedStatus,
        charge_attempt_id: attempt.id,
        stripe_payment_intent_id:
          persistedPaymentIntentId || stripeError.payment_intent?.id || null,
        stripe_charge_id:
          persistedChargeId || stripeChargeId(stripeError.payment_intent || {}),
        stripe_failure_code: succeededPaymentIntent
          ? null
          : stripeError.code || null,
        stripe_failure_message: succeededPaymentIntent ? null : failureMessage,
        blocked_reason: succeededPaymentIntent
          ? "stripe_final_charge_succeeded_recording_failed"
          : "stripe_final_charge_failed",
        updated_at: new Date(),
      })
    await orderModule.updateOrders(order.id, { metadata })
    // #251: every charge_failed_hold entry must emit an ops alert.
    await emitChargeFailedHoldAlert({
      logger,
      orderId: order.id,
      finalizationId: preview.finalization.id,
      chargeAttemptId: attempt.id,
      paymentIntentId:
        persistedPaymentIntentId || stripeError.payment_intent?.id || null,
      paymentIntentStatus:
        paymentIntent?.status || stripeError.payment_intent?.status || null,
      failureCode: succeededPaymentIntent
        ? "charge_succeeded_recording_failed"
        : stripeError.code || null,
      failureMessage,
    })

    return {
      result: succeededPaymentIntent
        ? "charge_recording_failed"
        : "charge_failed",
      status: succeededPaymentIntent ? 500 : 402,
      body: {
        message: succeededPaymentIntent
          ? "Stripe charge succeeded, but the order release could not be recorded. Do not retry the customer charge; reconcile this finalization."
          : failureMessage,
        finalization_status: failedStatus,
        payment_intent: succeededPaymentIntent
          ? {
              id: succeededPaymentIntent.id,
              status: succeededPaymentIntent.status,
              latest_charge: persistedChargeId,
            }
          : undefined,
        charge_attempt: attempt,
      },
    }
  }
}
