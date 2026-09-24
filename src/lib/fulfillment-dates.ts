import { validCivilDate } from "./fulfillment-calendar";

/** Arrival, preparation and dispatch are civil dates, never timezone instants. */
export function fulfillmentDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const date = us
    ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`
    : raw;
  return validCivilDate(date) ? date : null;
}

function firstDate(...values: unknown[]) {
  for (const value of values) {
    const date = fulfillmentDateKey(value);
    if (date) return date;
  }
  return null;
}

export function fulfillmentDates(metadata: Record<string, unknown>) {
  const mode = metadata.fulfillmentType || metadata.fulfillment_type;
  const arrivalDate = firstDate(
    ...(mode === "ups_shipping"
      ? [metadata.requestedDeliveryDate, metadata.scheduledDate]
      : [metadata.scheduledDate, metadata.requestedDeliveryDate]),
    metadata.requested_fulfillment_date,
    metadata.fulfillment_date,
    metadata.inventory_requested_fulfillment_date,
  );
  return {
    arrivalDate,
    pickDate: firstDate(metadata.fulfillmentPickDate),
    dispatchDate: firstDate(
      metadata.fulfillmentDispatchDate,
      // Existing checkout's camel-case QBD field means Sales Order dispatch.
      metadata.qbdDueDate,
      // Legacy same-day pickup/local delivery has no separate travel day.
      mode === "plant_pickup" ||
        mode === "atlanta_delivery" ||
        mode === "local_delivery"
        ? arrivalDate
        : null,
    ),
  };
}

export function formatFulfillmentDate(value: unknown): string {
  const key = fulfillmentDateKey(value);
  if (!key) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}T12:00:00Z`));
}
