import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  fulfillmentDateKey,
  fulfillmentDates,
} from "../../../../../lib/fulfillment-dates";
import { emitOpsAlert } from "../../../../../lib/ops-alert";
import { emitStaleQbdPostingAlertForOrders } from "../../../../../lib/qbd-pending-posting-alerts";

const DEFAULT_STATUSES = [
  "pending_pick",
  "picking",
  "ready_for_packing",
  "pending_pack",
  "packing",
  "packed_pending_review",
  "packed_pending_charge",
  "charge_failed_hold",
  "charged_ready_to_ship",
];

const OPEN_STATUSES_WITHOUT_FINAL_TOTALS = new Set([
  "pending_pick",
  "picking",
  "ready_for_packing",
  "pending_pack",
  "packing",
  "packed_pending_review",
]);

const clampLimit = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(Math.round(parsed), 200);
};

const clampScanLimit = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.min(Math.max(Math.round(parsed), 200), 500);
};

const textValue = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const metadataObject = (value: unknown): Record<string, any> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
};

const dateKey = (value: unknown) => fulfillmentDateKey(value) || "";

const orderFulfillmentType = (metadata: Record<string, any>) =>
  textValue(metadata.fulfillmentType) || textValue(metadata.fulfillment_type);

const routeErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error || "Unknown error");

async function emitFinalizationQueueFailureAlert(
  req: MedusaRequest,
  error: unknown,
  context: {
    statuses: string[];
    limit: number;
    scan_limit: boolean;
    has_query_text: boolean;
    has_fulfillment_type: boolean;
    has_date_from: boolean;
    has_date_to: boolean;
  },
) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);

  return emitOpsAlert({
    alertKind: "catch_weight_finalization_queue_failed",
    title: "Catch-weight finalization queue failed",
    path: "src/api/admin/grillers/finalization/queue/route.ts",
    source: "medusa-server",
    severity: "page",
    logger,
    meta: {
      statuses: context.statuses.slice(0, 20),
      status_count: context.statuses.length,
      limit: context.limit,
      scan_limit: context.scan_limit,
      has_query_text: context.has_query_text,
      has_fulfillment_type: context.has_fulfillment_type,
      has_date_from: context.has_date_from,
      has_date_to: context.has_date_to,
      error_message: routeErrorMessage(error).slice(0, 500),
    },
  });
}

async function ordersById(req: MedusaRequest, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, Record<string, any>>();

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "email",
      "metadata",
      "shipping_address.*",
      "billing_address.*",
    ],
    filters: { id: orderIds },
  });

  return new Map(
    (data || [])
      .filter((order: Record<string, any>) => order?.id)
      .map((order: Record<string, any>) => [order.id, order]),
  );
}

function searchableText(
  row: Record<string, any>,
  order: Record<string, any> | undefined,
) {
  const metadata = metadataObject(order?.metadata);
  const shipping = metadataObject(order?.shipping_address);
  const billing = metadataObject(order?.billing_address);
  return [
    row.display_id,
    row.order_id,
    row.customer_email,
    row.customer_id,
    order?.display_id,
    order?.email,
    metadata.fulfillmentType,
    metadata.fulfillment_type,
    metadata.fulfillmentZip,
    metadata.fulfillment_zip,
    metadata.pickupLocationId,
    metadata.scheduledDate,
    metadata.requestedDeliveryDate,
    metadata.requested_fulfillment_date,
    shipping.first_name,
    shipping.last_name,
    shipping.company,
    shipping.phone,
    shipping.city,
    shipping.province,
    shipping.postal_code,
    billing.first_name,
    billing.last_name,
    billing.company,
    billing.phone,
    billing.city,
    billing.province,
    billing.postal_code,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  let alertContext = {
    statuses: DEFAULT_STATUSES,
    limit: clampLimit(req.query?.limit),
    scan_limit: false,
    has_query_text: false,
    has_fulfillment_type: false,
    has_date_from: false,
    has_date_to: false,
  };

  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const statusQuery = req.query?.status;
    const rawQueryText =
      typeof req.query?.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const queryText = rawQueryText.replace(/#/g, "");
    const fulfillmentType =
      typeof req.query?.fulfillment_type === "string"
        ? req.query.fulfillment_type.trim()
        : "";
    const dateFrom = dateKey(req.query?.date_from);
    const dateTo = dateKey(req.query?.date_to);
    const hasOrderFilters = Boolean(
      queryText || fulfillmentType || dateFrom || dateTo,
    );
    const statuses =
      typeof statusQuery === "string" && statusQuery.trim()
        ? statusQuery
            .split(",")
            .map((status) => status.trim())
            .filter(Boolean)
        : DEFAULT_STATUSES;
    const dbLimit = hasOrderFilters
      ? clampScanLimit(req.query?.limit)
      : clampLimit(req.query?.limit);
    const responseLimit = clampLimit(req.query?.limit);

    alertContext = {
      statuses,
      limit: responseLimit,
      scan_limit: hasOrderFilters,
      has_query_text: Boolean(queryText),
      has_fulfillment_type: Boolean(fulfillmentType),
      has_date_from: Boolean(dateFrom),
      has_date_to: Boolean(dateTo),
    };

    const rows = await db("gp_order_finalization")
      .select("*")
      .whereNull("deleted_at")
      .whereIn("status", statuses)
      .orderByRaw(
        "case status when 'charge_failed_hold' then 0 when 'packed_pending_charge' then 1 when 'packed_pending_review' then 2 when 'packing' then 3 when 'ready_for_packing' then 4 when 'picking' then 5 when 'pending_pick' then 6 else 7 end",
      )
      .orderBy("created_at", "asc")
      .limit(dbLimit);

    const orders = await ordersById(
      req,
      (rows || [])
        .map((row: Record<string, any>) => row.order_id)
        .filter(Boolean),
    );
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
    await emitStaleQbdPostingAlertForOrders({
      orders: Array.from(orders.values()),
      logger,
    });

    const finalizations = (rows || [])
      .map((row: Record<string, any>) => {
        const order = orders.get(row.order_id);
        const metadata = metadataObject(order?.metadata);
        const fulfillment_type = orderFulfillmentType(metadata);
        const dates = fulfillmentDates(metadata);
        const fulfillment_date = dates.dispatchDate;
        const fulfillment_date_key = dateKey(fulfillment_date);
        return {
          ...(OPEN_STATUSES_WITHOUT_FINAL_TOTALS.has(row.status)
            ? {
                ...row,
                final_item_total: null,
                final_shipping_total: null,
                final_tax_total: null,
                final_discount_total: null,
                final_order_total: null,
                delta_total: null,
              }
            : row),
          order_email: order?.email || row.customer_email || null,
          fulfillment_type: fulfillment_type || null,
          fulfillment_date: fulfillment_date || null,
          fulfillment_date_key: fulfillment_date_key || null,
          arrival_date: dates.arrivalDate,
          pick_date: dates.pickDate,
          dispatch_date: dates.dispatchDate,
        };
      })
      .filter((row: Record<string, any>) => {
        const order = orders.get(row.order_id);
        if (queryText && !searchableText(row, order).includes(queryText)) {
          return false;
        }
        if (fulfillmentType && row.fulfillment_type !== fulfillmentType) {
          return false;
        }
        if (
          dateFrom &&
          (!row.fulfillment_date_key || row.fulfillment_date_key < dateFrom)
        ) {
          return false;
        }
        if (
          dateTo &&
          (!row.fulfillment_date_key || row.fulfillment_date_key > dateTo)
        ) {
          return false;
        }
        return true;
      })
      .slice(0, responseLimit);

    res.status(200).json({
      finalizations,
      count: finalizations.length,
    });
  } catch (error) {
    await emitFinalizationQueueFailureAlert(req, error, alertContext);
    res.status(500).json({
      message: "Could not load finalization queue.",
    });
  }
};
