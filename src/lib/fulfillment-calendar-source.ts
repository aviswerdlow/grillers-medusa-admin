import { z } from "zod";
import {
  CALENDAR_TIMEZONE,
  FulfillmentCalendarError,
  calendarHash,
  easternInstant,
  easternParts,
  readCalendarPolicy,
  shiftDate,
  validCivilDate,
  type CalendarPolicy,
  type CalendarTransit,
} from "./fulfillment-calendar";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const unwrap = (v: any) => v?.attributes ?? v;
const rows = (v: any): any[] => (Array.isArray(v) ? v.map(unwrap) : []);
const days = (v: unknown) =>
  Array.isArray(v)
    ? v.map((d) => (typeof d === "string" ? DAY_NAMES.indexOf(d) : d))
    : undefined;
const dates = (v: unknown, field = "Date") => rows(v).map((r) => r[field]);
const windows = (v: unknown) =>
  rows(v).map((r) => ({
    id: r.Key,
    label: r.Label,
    start: r.StartTime,
    end: r.EndTime,
  }));

/** Reuses published checkout closures, plant availability, local ZIP zones and
 * regional route dates. No static holiday/transit table is approval evidence. */
export function calendarPolicyFromStrapi(
  checkoutInput: unknown,
  zoneInput: unknown[],
  routeInput: unknown[],
  now: Date,
): CalendarPolicy {
  const c = unwrap(checkoutInput),
    p = unwrap(c?.FulfillmentCalendarPolicy);
  if (!c || !p)
    throw new FulfillmentCalendarError("calendar_policy_not_published", 503);
  const closures = rows(c.FulfillmentBlackoutDates);
  const legacyUps = dates(c.ShippingBlackoutDates, "BlackoutDate");
  const common = (r: any, windowRows: unknown) => ({
    preparationDays: r.CalendarPreparationDays,
    cutoffDays: r.CalendarCutoffDays,
    cutoffTime: r.CalendarCutoffTime,
    packTime: r.CalendarPackTime,
    windows: windows(windowRows),
  });
  return readCalendarPolicy(
    {
      revision: p.Revision,
      approvedAt: p.ApprovedAt,
      approvalReference: p.ApprovalReference,
      validFrom: p.ValidFrom,
      validThrough: p.ValidThrough,
      timezone: p.Timezone,
      lookAheadDays: p.LookAheadDays,
      quoteTtlSeconds: p.QuoteTtlSeconds,
      operationsWeekdays: days(p.OperationsWeekdays),
      operationsBlackouts: closures
        .filter((r) => r.BlocksOperations === true)
        .map((r) => r.Date),
      upsPickupBlackouts: [
        ...new Set([
          ...legacyUps,
          ...closures
            .filter((r) => r.BlocksUPSPickup === true)
            .map((r) => r.Date),
        ]),
      ],
      upsDeliveryBlackouts: [
        ...new Set([
          ...legacyUps,
          ...closures
            .filter((r) => r.BlocksUPSDelivery === true)
            .map((r) => r.Date),
        ]),
      ],
      ups: {
        dispatchWeekdays: days(p.UPSDispatchWeekdays),
        arrivalWeekdays: days(p.UPSArrivalWeekdays),
        carrierWeekdays: days(p.UPSCarrierWeekdays),
        preparationDays: p.UPSPreparationDays,
        cutoffTime: p.UPSOrderCutoffTime,
        packTime: p.UPSPackTime,
        arrivalByTime: p.UPSArrivalByTime,
        maxElapsedHours: p.UPSMaxElapsedHours,
        allowNonDeliveryDayHold: p.UPSAllowNonDeliveryDayHold,
      },
      plant: {
        ...common(p, p.PlantWindows),
        weekdays: days(c.PlantPickupAvailableDays),
        additionalDates: dates(c.PlantPickupAdditionalDates),
        blackoutDates: dates(c.PlantPickupBlackoutDates),
        cutoffOverrides: rows(p.PlantCutoffOverrides).map((r) => ({
          weekday: DAY_NAMES.indexOf(r.Weekday),
          time: r.CutoffTime,
        })),
      },
      atlanta: zoneInput
        .map(unwrap)
        .filter((r) => r.IsActive === true)
        .map((r) => ({
          ...common(r, r.CalendarWindows),
          id: r.documentId ?? String(r.id),
          zip: r.ZipCode,
          weekdays:
            Array.isArray(r.Weekdays) && r.Weekdays.length
              ? days(r.Weekdays)
              : days([r.DeliveryDay]),
        })),
      southeast: routeInput
        .map(unwrap)
        .filter((r) => r.IsActive === true)
        .map((r) => ({
          ...common(r, r.CalendarWindows),
          id: r.documentId ?? String(r.id),
          city: r.City,
          state: r.State,
          active: r.IsActive === true,
          dates: dates(r.AvailableDates),
        })),
    },
    now,
  );
}

const ruleSchema = z
  .object({
    Service: z.enum(["GROUND", "3_DAY_SELECT", "2ND_DAY_AIR", "OVERNIGHT"]),
    OriginPostalCode: z.string().regex(/^\d{5}$/),
    DestinationZipPrefix: z.string().regex(/^\d{1,5}$/),
    BusinessDays: z.number().int().min(1).max(14),
    Revision: z.string().trim().min(1),
    ApprovedAt: z.string().datetime({ offset: true }),
    ApprovalReference: z.string().trim().min(1),
    ValidFrom: z.string().refine(validCivilDate),
    ValidThrough: z.string().refine(validCivilDate),
  })
  .refine((r) => r.ValidFrom <= r.ValidThrough);

export function approvedTransitFallback(input: {
  rules: unknown;
  service: string;
  postalCode: string;
  originPostalCode: string;
  now: Date;
}): CalendarTransit | null {
  const parsed = z.array(ruleSchema).safeParse(input.rules);
  if (!parsed.success)
    throw new FulfillmentCalendarError("transit_rules_invalid", 503);
  if (!/^\d{5}$/.test(input.postalCode)) return null;
  const today = easternParts(input.now).date;
  const matches = parsed.data
    .filter(
      (r) =>
        r.Service === input.service &&
        r.OriginPostalCode === input.originPostalCode &&
        input.postalCode.startsWith(r.DestinationZipPrefix) &&
        r.ValidFrom <= today &&
        r.ValidThrough >= today &&
        Date.parse(r.ApprovedAt) <= input.now.getTime(),
    )
    .sort(
      (a, b) => b.DestinationZipPrefix.length - a.DestinationZipPrefix.length,
    );
  if (!matches.length) return null;
  const r = matches[0];
  if (
    matches.filter(
      (v) => v.DestinationZipPrefix.length === r.DestinationZipPrefix.length,
    ).length !== 1
  )
    throw new FulfillmentCalendarError("transit_rule_ambiguous", 503);
  return {
    businessDays: r.BusinessDays,
    service: r.Service,
    originPostalCode: r.OriginPostalCode,
    destinationPostalCode: input.postalCode,
    source: "approved_fallback",
    revision: `${r.Revision}:${calendarHash(r)}`,
    validFrom: r.ValidFrom,
    validThrough: r.ValidThrough,
    fetchedAt: input.now.toISOString(),
    expiresAt: easternInstant(
      shiftDate(r.ValidThrough, 1),
      "00:00",
    ).toISOString(),
  };
}

type Env = Record<string, string | undefined>;
export type CalendarSource = {
  policy: CalendarPolicy;
  transitRules: unknown[];
  originPostalCode: string;
};
/** Never use stale closures on an acceptance check. Failures are explicit 503s;
 * an empty or truncated collection cannot become a fabricated default schedule. */
export async function loadCalendarSource(
  env: Env = process.env,
  now = new Date(),
): Promise<CalendarSource> {
  const base = env.STRAPI_URL?.replace(/\/+$/, ""),
    token = env.STRAPI_TOKEN;
  if (!base || !token)
    throw new FulfillmentCalendarError("calendar_source_unconfigured", 503);
  const get = async (path: string) => {
    try {
      const res = await fetch(`${base}/api/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2500),
        redirect: "error",
      });
      if (!res.ok) throw new Error("calendar_fetch_failed");
      return (await res.json()) as any;
    } catch {
      throw new FulfillmentCalendarError("calendar_source_unavailable", 503);
    }
  };
  const collection = async (name: string) => {
    const out: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const value = await get(
        `${name}?populate=*&pagination[page]=${page}&pagination[pageSize]=100&sort=id:asc`,
      );
      if (!Array.isArray(value.data))
        throw new FulfillmentCalendarError("calendar_collection_invalid", 503);
      out.push(...value.data);
      const meta = value.meta?.pagination;
      if (
        !meta ||
        meta.page !== page ||
        !Number.isInteger(meta.pageCount) ||
        !Number.isInteger(meta.total)
      )
        throw new FulfillmentCalendarError("calendar_pagination_missing", 503);
      if (page >= meta.pageCount) {
        if (out.length !== meta.total)
          throw new FulfillmentCalendarError(
            "calendar_pagination_changed",
            503,
          );
        return out;
      }
    }
    throw new FulfillmentCalendarError("calendar_collection_limit", 503);
  };
  const [checkout, zones, routes] = await Promise.all([
    get(
      "checkout?populate[FulfillmentCalendarPolicy][populate]=*&populate[FulfillmentTransitRules]=*&populate[FulfillmentBlackoutDates]=*&populate[ShippingBlackoutDates]=*&populate[PlantPickupAdditionalDates]=*&populate[PlantPickupBlackoutDates]=*",
    ),
    collection("atlanta-delivery-zones"),
    collection("southeast-pickup-locations"),
  ]);
  const c = unwrap(checkout.data),
    p = unwrap(c?.FulfillmentCalendarPolicy);
  if (!/^\d{5}$/.test(p?.OriginPostalCode ?? ""))
    throw new FulfillmentCalendarError("calendar_origin_missing", 503);
  return {
    policy: calendarPolicyFromStrapi(c, zones, routes, now),
    transitRules: rows(c.FulfillmentTransitRules),
    originPostalCode: p.OriginPostalCode,
  };
}
