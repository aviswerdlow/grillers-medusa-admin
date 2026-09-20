import { createHash } from "node:crypto";
import { z } from "zod";

export const CALENDAR_TIMEZONE = "America/New_York";
export const CALENDAR_SELECTION_KEY = "fulfillment_calendar_selection_v1";
export const CALENDAR_ACCEPTED_KEY = "fulfillment_calendar_accepted_v1";
const DAY_MS = 86_400_000;
const MODES = [
  "ups_shipping",
  "plant_pickup",
  "atlanta_delivery",
  "southeast_pickup",
] as const;
export type CalendarMode = (typeof MODES)[number];

export class FulfillmentCalendarError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(
      status === 503
        ? "Delivery and pickup dates are temporarily unavailable. Please try again or contact us."
        : "Your delivery or pickup selection changed or expired. Please choose an available date again.",
    );
    this.name = "FulfillmentCalendarError";
  }
}

export function validCivilDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
const date = z
  .string()
  .refine(validCivilDate, "Expected a real YYYY-MM-DD date");
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instant = z.string().datetime({ offset: true });
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((v) => new Set(v).size === v.length, "Duplicate weekday");
const text = z.string().trim().min(1).max(240);
const windowSchema = z
  .object({ id: text, label: text, start: time, end: time })
  .refine(
    (v) => v.start < v.end,
    "Windows must end on the same day after they start",
  );
const schedule = z.object({
  preparationDays: z.number().int().min(0).max(14),
  cutoffDays: z.number().int().min(0).max(30),
  cutoffTime: time,
  packTime: time,
  windows: z.array(windowSchema).min(1).max(12),
});
export const calendarPolicySchema = z
  .object({
    revision: text,
    approvedAt: instant,
    approvalReference: text,
    validFrom: date,
    validThrough: date,
    timezone: z.literal(CALENDAR_TIMEZONE),
    lookAheadDays: z.number().int().min(1).max(60),
    quoteTtlSeconds: z.number().int().min(30).max(1800),
    operationsWeekdays: weekdays.refine((v) => v.length > 0),
    operationsBlackouts: z.array(date),
    upsPickupBlackouts: z.array(date),
    upsDeliveryBlackouts: z.array(date),
    ups: z.object({
      dispatchWeekdays: weekdays.refine((v) => v.length > 0),
      arrivalWeekdays: weekdays.refine((v) => v.length > 0),
      carrierWeekdays: weekdays.refine((v) => v.length > 0),
      preparationDays: z.number().int().min(0).max(14),
      cutoffTime: time,
      packTime: time,
      arrivalByTime: time,
      maxElapsedHours: z.number().int().min(1).max(336),
      allowNonDeliveryDayHold: z.boolean(),
    }),
    plant: schedule.extend({
      weekdays,
      additionalDates: z.array(date),
      blackoutDates: z.array(date),
      cutoffOverrides: z.array(
        z.object({ weekday: z.number().int().min(0).max(6), time }),
      ),
    }),
    atlanta: z.array(
      schedule.extend({ id: text, zip: z.string().regex(/^\d{5}$/), weekdays }),
    ),
    southeast: z.array(
      schedule.extend({
        id: text,
        city: text,
        state: z.string().regex(/^[A-Z]{2}$/),
        active: z.boolean(),
        dates: z.array(date),
      }),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.validFrom > v.validThrough)
      ctx.addIssue({ code: "custom", message: "Reversed calendar coverage" });
    for (const keys of [
      v.atlanta.map((r) => r.zip),
      v.southeast.map((r) => r.id),
      v.plant.cutoffOverrides.map((r) => r.weekday),
    ])
      if (new Set<string | number>(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: "Ambiguous calendar rows" });
    for (const s of [v.plant, ...v.atlanta, ...v.southeast])
      if (new Set(s.windows.map((w) => w.id)).size !== s.windows.length)
        ctx.addIssue({ code: "custom", message: "Ambiguous time windows" });
  });
export type CalendarPolicy = z.infer<typeof calendarPolicySchema>;
export type CalendarTransit = {
  businessDays: number;
  source: "carrier_cache" | "approved_fallback";
  revision: string;
  fetchedAt: string;
  expiresAt: string;
  validFrom: string;
  validThrough: string;
  originPostalCode: string;
  destinationPostalCode: string;
  service: string;
  dispatchDate?: string;
  estimatedArrivalDate?: string;
};
export type CalendarRequest = {
  mode: CalendarMode;
  service: string;
  postalCode: string;
  routeId?: string;
};
export type CalendarChoice = {
  arrivalDate: string;
  dispatchDate: string;
  pickDate: string;
  window: { id: string; label: string; start: string; end: string } | null;
  cutoffAt: string;
  packedAt: string;
  arrivalBy: string;
  elapsedPackingHours: number;
  packingDays: number;
  transitBusinessDays: number;
  transit: CalendarTransit | null;
};
export type CalendarResult = {
  version: 1;
  timezone: typeof CALENDAR_TIMEZONE;
  calendarRevision: string;
  generatedAt: string;
  expiresAt: string;
  request: CalendarRequest;
  choices: CalendarChoice[];
  unavailableReason:
    | "no_available_dates"
    | "unknown_route"
    | "missing_transit"
    | null;
};

export function calendarHash(value: unknown): string {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, canonical(v[key])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value ?? null)))
    .digest("hex");
}
export function shiftDate(value: string, days: number): string {
  if (!validCivilDate(value) || !Number.isInteger(days))
    throw new FulfillmentCalendarError("invalid_date");
  return new Date(Date.parse(value + "T00:00:00Z") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
const weekday = (value: string) => new Date(value + "T00:00:00Z").getUTCDay();
export function easternParts(at: Date) {
  if (!Number.isFinite(at.getTime()))
    throw new FulfillmentCalendarError("invalid_clock", 503);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CALENDAR_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
/** Use the actual Eastern offset for this date. Ambiguous fall-back times close
 * at the earlier occurrence; nonexistent spring-forward cutoffs are rejected. */
export function easternInstant(civil: string, localTime: string): Date {
  if (!validCivilDate(civil) || !time.safeParse(localTime).success)
    throw new FulfillmentCalendarError("invalid_local_time", 503);
  const target = Date.parse(`${civil}T${localTime}:00Z`);
  let value = target;
  for (let i = 0; i < 4; i++) {
    const local = easternParts(new Date(value));
    const offset = Date.parse(`${local.date}T${local.time}Z`) - value;
    value = target - offset;
  }
  const candidates = [value - 3_600_000, value, value + 3_600_000].filter(
    (n) => {
      const parts = easternParts(new Date(n));
      return parts.date === civil && parts.time === localTime + ":00";
    },
  );
  if (!candidates.length)
    throw new FulfillmentCalendarError("nonexistent_local_cutoff", 503);
  return new Date(Math.min(...candidates));
}

export function readCalendarPolicy(value: unknown, now: Date): CalendarPolicy {
  const parsed = calendarPolicySchema.safeParse(value);
  if (!parsed.success)
    throw new FulfillmentCalendarError("calendar_unapproved_or_invalid", 503);
  const p = parsed.data,
    today = easternParts(now).date;
  if (
    Date.parse(p.approvedAt) > now.getTime() ||
    today < p.validFrom ||
    today > p.validThrough
  )
    throw new FulfillmentCalendarError(
      "calendar_outside_approved_coverage",
      503,
    );
  return p;
}

function advanceOpenDate(
  start: string,
  count: number,
  direction: 1 | -1,
  open: (d: string) => boolean,
): string | null {
  let cursor = start,
    remaining = count;
  for (let i = 0; i < 366; i++) {
    if (remaining === 0) return open(cursor) ? cursor : null;
    cursor = shiftDate(cursor, direction);
    if (open(cursor)) remaining--;
  }
  return null;
}

export function computeFulfillmentCalendar(input: {
  policy: unknown;
  request: CalendarRequest;
  transit?: CalendarTransit | null;
  now: Date;
}): CalendarResult {
  const { request, now } = input;
  if (!MODES.includes(request.mode))
    throw new FulfillmentCalendarError("invalid_mode");
  const p = readCalendarPolicy(input.policy, now),
    today = easternParts(now).date;
  const revision = calendarHash(p);
  const covered = (d: string) => d >= p.validFrom && d <= p.validThrough;
  const operations = (d: string) =>
    covered(d) &&
    p.operationsWeekdays.includes(weekday(d)) &&
    !p.operationsBlackouts.includes(d);
  const carrier = (d: string) =>
    covered(d) &&
    p.ups.carrierWeekdays.includes(weekday(d)) &&
    !p.upsDeliveryBlackouts.includes(d);
  const horizon = [shiftDate(today, p.lookAheadDays), p.validThrough].sort()[0];
  const choices: CalendarChoice[] = [];
  const result: CalendarResult = {
    version: 1,
    timezone: CALENDAR_TIMEZONE,
    calendarRevision: `${p.revision}:${revision}`,
    generatedAt: now.toISOString(),
    expiresAt: new Date(
      Math.min(
        now.getTime() + p.quoteTtlSeconds * 1000,
        easternInstant(shiftDate(p.validThrough, 1), "00:00").getTime(),
      ),
    ).toISOString(),
    request,
    choices,
    unavailableReason: null,
  };
  const makeChoice = (
    arrival: string,
    dispatch: string,
    pick: string,
    cutoff: Date,
    packTime: string,
    end: string,
    window: CalendarChoice["window"],
    transit: CalendarTransit | null,
  ) => {
    if (pick < today || !covered(pick) || !covered(dispatch)) return;
    const packedAt = easternInstant(pick, packTime),
      arrivalBy = easternInstant(arrival, end);
    // An order cannot be accepted after either its order cutoff or planned pack time.
    const deadline = new Date(Math.min(cutoff.getTime(), packedAt.getTime()));
    if (now >= deadline || arrivalBy < packedAt) return;
    const hours = (arrivalBy.getTime() - packedAt.getTime()) / 3_600_000;
    if (request.mode === "ups_shipping" && hours > p.ups.maxElapsedHours)
      return;
    choices.push({
      arrivalDate: arrival,
      dispatchDate: dispatch,
      pickDate: pick,
      window,
      cutoffAt: deadline.toISOString(),
      packedAt: packedAt.toISOString(),
      arrivalBy: arrivalBy.toISOString(),
      elapsedPackingHours: Number(hours.toFixed(4)),
      packingDays: Math.max(1, Math.ceil(hours / 24)),
      transitBusinessDays: transit?.businessDays ?? 0,
      transit,
    });
  };
  if (request.mode === "ups_shipping") {
    const t = input.transit;
    if (
      !t ||
      !Number.isInteger(t.businessDays) ||
      t.businessDays < 1 ||
      t.businessDays > 14 ||
      t.service !== request.service ||
      t.destinationPostalCode !== request.postalCode ||
      !/^\d{5}$/.test(t.originPostalCode) ||
      !t.revision ||
      !["carrier_cache", "approved_fallback"].includes(t.source) ||
      !Number.isFinite(Date.parse(t.expiresAt)) ||
      Date.parse(t.expiresAt) <= now.getTime() ||
      !validCivilDate(t.validFrom) ||
      !validCivilDate(t.validThrough) ||
      !Number.isFinite(Date.parse(t.fetchedAt)) ||
      Date.parse(t.fetchedAt) > now.getTime()
    ) {
      result.unavailableReason = "missing_transit";
      return result;
    }
    result.expiresAt = new Date(
      Math.min(Date.parse(result.expiresAt), Date.parse(t.expiresAt)),
    ).toISOString();
    for (
      let dispatch = today;
      dispatch <= horizon;
      dispatch = shiftDate(dispatch, 1)
    ) {
      if (
        !operations(dispatch) ||
        !p.ups.dispatchWeekdays.includes(weekday(dispatch)) ||
        p.upsPickupBlackouts.includes(dispatch)
      )
        continue;
      if (
        dispatch < t.validFrom ||
        (t.dispatchDate && t.dispatchDate !== dispatch)
      )
        continue;
      const arrival = advanceOpenDate(dispatch, t.businessDays, 1, carrier);
      if (
        !arrival ||
        arrival > horizon ||
        arrival > t.validThrough ||
        !p.ups.arrivalWeekdays.includes(weekday(arrival))
      )
        continue;
      if (t.estimatedArrivalDate && t.estimatedArrivalDate !== arrival)
        continue;
      if (
        !p.ups.allowNonDeliveryDayHold &&
        (Date.parse(arrival) - Date.parse(dispatch)) / DAY_MS !== t.businessDays
      )
        continue;
      const pick = advanceOpenDate(
        dispatch,
        p.ups.preparationDays,
        -1,
        operations,
      );
      if (pick)
        makeChoice(
          arrival,
          dispatch,
          pick,
          easternInstant(pick, p.ups.cutoffTime),
          p.ups.packTime,
          p.ups.arrivalByTime,
          null,
          t,
        );
    }
  } else {
    const selected =
      request.mode === "plant_pickup"
        ? p.plant
        : request.mode === "atlanta_delivery"
          ? p.atlanta.find((r) => r.zip === request.postalCode)
          : p.southeast.find((r) => r.id === request.routeId && r.active);
    if (!selected) {
      result.unavailableReason = "unknown_route";
      return result;
    }
    for (
      let arrival = today;
      arrival <= horizon;
      arrival = shiftDate(arrival, 1)
    ) {
      if (p.operationsBlackouts.includes(arrival)) continue;
      const day = weekday(arrival);
      if (request.mode === "plant_pickup") {
        if (
          p.plant.blackoutDates.includes(arrival) ||
          (!p.plant.weekdays.includes(day) &&
            !p.plant.additionalDates.includes(arrival))
        )
          continue;
      } else if (request.mode === "atlanta_delivery") {
        if (
          !(selected as CalendarPolicy["atlanta"][number]).weekdays.includes(
            day,
          )
        )
          continue;
      } else if (
        !(selected as CalendarPolicy["southeast"][number]).dates.includes(
          arrival,
        )
      )
        continue;
      // Explicit route/additional dates may operate outside the recurring pack week.
      const pick =
        selected.preparationDays === 0
          ? arrival
          : advanceOpenDate(arrival, selected.preparationDays, -1, operations);
      if (!pick) continue;
      const cutoffTime =
        request.mode === "plant_pickup"
          ? (p.plant.cutoffOverrides.find((r) => r.weekday === day)?.time ??
            selected.cutoffTime)
          : selected.cutoffTime;
      const cutoff = easternInstant(
        shiftDate(arrival, -selected.cutoffDays),
        cutoffTime,
      );
      for (const window of selected.windows)
        makeChoice(
          arrival,
          arrival,
          pick,
          cutoff,
          selected.packTime,
          window.end,
          window,
          null,
        );
    }
  }
  if (!choices.length) result.unavailableReason = "no_available_dates";
  return result;
}
