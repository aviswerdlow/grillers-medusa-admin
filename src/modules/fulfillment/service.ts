// src/modules/grillers-fulfillment/service.ts
import {
  AbstractFulfillmentProviderService,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import type {
  Logger,
  CalculateShippingOptionPriceDTO,
  CreateShippingOptionDTO,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
  FulfillmentDTO,
  CreateFulfillmentResult,
  CalculatedShippingOptionPrice,
  FulfillmentOption,
} from "@medusajs/framework/types";

import StrapiModuleService from "../strapi/service";
import { STRAPI_MODULE } from "../strapi";
import {
  atlantaDeliveryRateCents,
  eligibleSubtotalAmount,
  eligibleSubtotalCents,
  type AtlantaDeliveryZoneRate,
} from "./rates";
import {
  createWwexSpeedshipClientFromEnv,
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
  type WwexSpeedshipClient,
  wwexRateInputFromFulfillmentData,
} from "./wwex-speedship";
import { emitOpsAlert } from "../../lib/ops-alert";
import {
  forecastShippingCost,
  forecastModelFileMtimeMs,
  loadShippingCostForecastModel,
  loadShippingCostForecastModelResult,
  shippingForecastInputFromFulfillmentData,
  type ShippingCostForecastResult,
} from "../../lib/shipping-cost-forecast";
import { getPackagingConfig } from "../../lib/packaging-cost-strapi";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
  type ShippingPackingPlan,
} from "../../lib/shipping-packing-plan";
import { ShippingInputError } from "../../lib/shipping-weights";
import { loadShippingCatalogLines } from "../../lib/shipping-catalog-inputs";
import { calendarPackingContextForRate } from "../../lib/fulfillment-calendar-runtime";
import { FulfillmentCalendarError } from "../../lib/fulfillment-calendar";

import {
  composeShippingPrice,
  issueShippingPriceToken,
  readShippingPriceToken,
  SHIPPING_PRICE_TOKEN_KEY,
  type ShippingPriceQuote,
  type ShippingPriceSource,
} from "../../lib/shipping-price-contract";
import { getShippingPricePolicy } from "../../lib/shipping-price-policy-strapi";

type ComposedCarrierRate = {
  quote: ShippingPriceQuote;
  plan: ShippingPackingPlan;
};

type InjectedDependencies = {
  logger: Logger;
};

type Options = {
  apiKey?: string;
  endpoint?: string;
};

type FulfillmentServiceDefinition = {
  id: string;
  name: string;
  code: string;
};

export const FULFILLMENT_SERVICES: FulfillmentServiceDefinition[] = [
  {
    id: "pickup",
    name: "Pickup From Plant Premises in Atlanta, GA",
    code: "PICKUP",
  },
  {
    id: "atlanta",
    name: "Metro Atlanta Delivery",
    code: "ATLANTA_DELIVERY",
  },
  {
    id: "scheduled",
    name: "Scheduled Delivery",
    code: "SCHEDULED_DELIVERY",
  },
  {
    id: "ground",
    name: "UPS Ground Estimated Shipping",
    code: "GROUND",
  },
  {
    id: "ups_3_day_select",
    name: "UPS 3 Day Select Estimated Shipping",
    code: "3_DAY_SELECT",
  },
  {
    id: "ups_2nd_day_air",
    name: "UPS 2nd Day Air Estimated Shipping",
    code: "2ND_DAY_AIR",
  },
  {
    id: "overnight",
    name: "UPS Overnight Estimated Shipping",
    code: "OVERNIGHT",
  },
];

const SHIPPING_ZONE_CODE_ALIASES: Record<string, string[]> = {
  GROUND: ["FedexGround", "UPSGround", "UPS Ground", "GROUND"],
  "3_DAY_SELECT": [
    "Fedex3Day",
    "Fedex3DaySelect",
    "UPS3Day",
    "UPS3DaySelect",
    "UPS 3 Day Select",
    "3_DAY_SELECT",
  ],
  "2ND_DAY_AIR": [
    "Fedex2Day",
    "FedexSecondDay",
    "UPS2Day",
    "UPSSecondDay",
    "UPS 2nd Day Air",
    "2ND_DAY_AIR",
  ],
  OVERNIGHT: ["FedexOvernight", "UPSOvernight", "UPS Overnight", "OVERNIGHT"],
};

const EXPEDITED_UPS_SERVICE_CODES = new Set([
  "3_DAY_SELECT",
  "2ND_DAY_AIR",
  "OVERNIGHT",
]);

export function normalizeServiceCode(serviceCode: unknown): string {
  const normalized = String(serviceCode || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_");

  if (!normalized) return "";
  if (normalized.includes("GROUND")) return "GROUND";
  if (
    normalized.includes("OVERNIGHT") ||
    normalized.includes("NEXT_DAY") ||
    normalized.includes("NEXTDAY")
  ) {
    return "OVERNIGHT";
  }
  if (
    normalized.includes("2ND_DAY") ||
    normalized.includes("SECOND_DAY") ||
    normalized.includes("TWO_DAY") ||
    normalized.includes("2DAY")
  ) {
    return "2ND_DAY_AIR";
  }
  if (
    normalized.includes("3_DAY") ||
    normalized.includes("3RD_DAY") ||
    normalized.includes("THIRD_DAY") ||
    normalized.includes("THREE_DAY") ||
    normalized.includes("3DAY")
  ) {
    return "3_DAY_SELECT";
  }

  return normalized;
}

function normalizeZoneCode(zoneCode: unknown): string {
  return String(zoneCode || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "");
}

function zoneCodeMatches(zoneCode: unknown, aliases: string[]): boolean {
  const normalized = normalizeZoneCode(zoneCode);
  return aliases.some((alias) => normalizeZoneCode(alias) === normalized);
}

function strapiRow<T extends Record<string, unknown>>(row: unknown): T | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return ((value.attributes as T | undefined) || (value as T)) ?? null;
}

function envNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// Watch-only: compute + log the forecast but don't let it set the customer's price.
function forecastShadowMode(env: Record<string, string | undefined>): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(env.GRILLERS_SHIPPING_FORECAST_SHADOW || "").toLowerCase(),
  );
}

// No real UPS small-parcel domestic shipment costs less than this; a forecast
// charge below it is treated as non-confident (degenerate / out-of-distribution)
// and falls through to WWEX/Strapi. Operators can override or disable with 0.
const DEFAULT_MIN_FORECAST_USD = 5;
// The forecast sets real checkout prices. If an operator forgets to configure a
// cap, keep a code-level rail so a bad model cannot quote an unbounded charge.
// Set GRILLERS_SHIPPING_FORECAST_MAX_USD=0 to deliberately disable.
const DEFAULT_MAX_FORECAST_USD = 250;

function forecastMaxUsd(env: Record<string, string | undefined>): number {
  return (
    envNumber(env.GRILLERS_SHIPPING_FORECAST_MAX_USD) ??
    DEFAULT_MAX_FORECAST_USD
  );
}

function shippingForecastEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(env.GRILLERS_SHIPPING_FORECAST_ENABLED || "")
      .toLowerCase()
      .trim(),
  );
}

/**
 * Turns a model prediction (mean cost) into the dollar amount to charge at
 * checkout, or null if the forecast is not confident (caller falls through to
 * WWEX/Strapi). The cushion has two parts:
 *  - markup: multiplicative (default from the model, e.g. 1.20 = "20% buffer" for
 *    the GBM model; scales with order size so big orders get more protection).
 *    Override with GRILLERS_SHIPPING_FORECAST_MARKUP.
 *  - buffer: additive percentile residual. To avoid double-cushioning, a markup
 *    model (>1) defaults to no additive buffer; the linear model defaults to p75.
 * A non-positive estimate, or a charge outside the optional MIN/MAX sanity band,
 * is treated as non-confident -> null -> fall through. We deliberately do NOT
 * clamp up to the Strapi tier (that table is inflated, ~$75 ground vs ~$18 real).
 */
function resolveForecastCharge(
  forecast: ShippingCostForecastResult,
  env: Record<string, string | undefined>,
): number | null {
  if (!(forecast.amount > 0)) return null;
  const modelMarkup = forecast.metadata.default_markup;
  const markup =
    envNumber(env.GRILLERS_SHIPPING_FORECAST_MARKUP) ??
    (modelMarkup && modelMarkup > 0 ? modelMarkup : 1);
  const usesMarkup = markup > 1;
  const percentile = String(
    env.GRILLERS_SHIPPING_FORECAST_SAFETY_PERCENTILE ||
      (usesMarkup ? "p50" : "p75"),
  ).toLowerCase();
  const buffer =
    percentile === "p90"
      ? forecast.confidence.residual_p90
      : percentile === "p50" || percentile === "none"
        ? 0
        : forecast.confidence.residual_p75;
  const charge =
    Math.round((forecast.amount * markup + buffer + Number.EPSILON) * 100) /
    100;
  const minUsd =
    envNumber(env.GRILLERS_SHIPPING_FORECAST_MIN_USD) ??
    DEFAULT_MIN_FORECAST_USD;
  const maxUsd = forecastMaxUsd(env);
  if (minUsd > 0 && charge < minUsd) return null;
  if (maxUsd != null && maxUsd > 0 && charge > maxUsd) return null;
  return charge;
}

export default class GrillersFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "grillers-fulfillment"; // => stored as fp_grillers_<id> in DB

  protected logger_: Logger;
  protected options_: Options;
  protected shippingContainer_: any;
  protected strapiSvc: any;
  protected wwexClient: WwexSpeedshipClient | null;
  protected shippingCostForecastModel: ReturnType<
    typeof loadShippingCostForecastModel
  >;
  protected shippingForecastModelPath: string | null;
  protected shippingForecastModelMtimeMs: number | null;

  // Example: your external shipper SDK/client
  protected client: {
    hasRates: (optionId: string) => Promise<boolean>;
    calculate: (
      data: Record<string, unknown>,
    ) => Promise<number | ComposedCarrierRate>;
    create: (
      fulfillment: Partial<
        Omit<FulfillmentDTO, "provider_id" | "data" | "items">
      >,
      items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    ) => Promise<Record<string, unknown>>;
    createReturn: (
      fulfillment: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    cancel: (externalId: string) => Promise<void>;
    getDocuments: (
      externalId: string,
    ) => Promise<Array<{ name: string; url: string }>>;
    getServices: () => Promise<
      Array<{ id: string; name: string; code: string }>
    >;
  };

  constructor(container: any, options: Options) {
    super();
    this.logger_ = container.logger;
    this.options_ = options;
    this.shippingContainer_ = container;
    this.logger_.info("GrillersFulfillmentProviderService loaded");
    this.wwexClient = createWwexSpeedshipClientFromEnv(
      process.env,
      this.logger_,
    );
    this.shippingCostForecastModel = null;
    this.shippingForecastModelPath = null;
    this.shippingForecastModelMtimeMs = null;
    this.reloadForecastModel(); // boot-safe: never throws, fails open on a bad model file
    // this.strapiSvc = container.resolve(STRAPI_MODULE) as StrapiModuleService;

    // Initialize your third-party client here (SDK, REST wrapper, etc.)
    // For demo purposes, we mock the needed methods:
    this.client = {
      hasRates: async (optionId) => {
        return true;
      },
      calculate: async (optionData) => {
        // @ts-ignore
        const city: string = optionData?.shipping_address?.city;
        // @ts-ignore
        const state: string = optionData?.shipping_address?.province;
        // @ts-ignore
        const zip: string = optionData?.shipping_address?.postal_code;
        const serviceCode = normalizeServiceCode(optionData?.service_code);
        let items = Array.isArray(optionData?.items) ? optionData.items : [];

        // All carrier paths share physical mass and fit inputs, even when the
        // customer packaging charge is disabled. Missing inputs cannot fall
        // through to a normal zero/one-pound quote or a price-table success.
        let packingPlan: ShippingPackingPlan | undefined;
        if (isUpsServiceCode(serviceCode)) {
          try {
            items = await loadShippingCatalogLines(
              this.shippingContainer_.query,
              items,
            );
            const dates = await calendarPackingContextForRate(
              this.shippingContainer_.query,
              optionData?.id || optionData?.cart_id,
              serviceCode,
            );
            packingPlan = createShippingPackingPlan(
              items,
              dates,
              await getPackagingConfig(process.env),
            );
          } catch (error) {
            if (error instanceof FulfillmentCalendarError)
              throw new MedusaError(
                MedusaError.Types.NOT_ALLOWED,
                error.message,
              );
            if (!(error instanceof ShippingInputError)) throw error;
            await emitOpsAlert({
              alertKind: "shipping_inputs_unavailable",
              title: "Carrier shipping needs an item-weight or packing review",
              path: "src/modules/fulfillment/service.ts",
              source: "medusa",
              severity: "warn",
              logger: this.logger_,
              meta: {
                reason: error.code,
                item_count: items.length,
                service_code: serviceCode,
              },
            });
            throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
          }
        }
        const pricePolicy = packingPlan ? await getShippingPricePolicy() : null;
        const compose = (
          source: ShippingPriceSource,
          rate: number,
          carrierFreightEstimate?: number,
        ): ComposedCarrierRate => ({
          quote: composeShippingPrice({
            source,
            rate,
            carrierFreightEstimate,
            currency: String(optionData.currency_code || ""),
            plan: packingPlan!,
            policy: pricePolicy!,
          }),
          plan: packingPlan!,
        });
        if (packingPlan && optionData[SHIPPING_PRICE_TOKEN_KEY]) {
          return {
            quote: readShippingPriceToken(
              optionData[SHIPPING_PRICE_TOKEN_KEY],
              optionData,
              packingPlan,
              pricePolicy!,
            ),
            plan: packingPlan,
          };
        }
        const forecastAmount = this.calculateForecastShippingRate(
          {
            ...optionData,
            service_code: serviceCode,
            shipping_address: optionData?.shipping_address,
            items,
          },
          packingPlan,
        );
        // Shadow mode: the forecast is computed and logged (in calculateForecastShippingRate)
        // for watch-only comparison, but does NOT set the customer's price — we fall through
        // to the live WWEX/Strapi rate. Flip GRILLERS_SHIPPING_FORECAST_SHADOW off to go live.
        if (forecastAmount !== null && !forecastShadowMode(process.env)) {
          return compose(
            "forecast",
            forecastAmount.amount,
            forecastAmount.rawFreight,
          );
        }

        const wwexAmount = await this.calculateWwexShippingRate(
          {
            ...optionData,
            packages: undefined,
            service_code: serviceCode,
            shipping_address: optionData?.shipping_address,
            items,
          },
          packingPlan,
        );
        if (wwexAmount !== null) {
          return compose("wwex", wwexAmount);
        }

        const eligibleSubtotal = eligibleSubtotalAmount(items);
        const eligibleSubtotalInCents = eligibleSubtotalCents(items);

        if (serviceCode == "ATLANTA_DELIVERY" && zip) {
          let structuredRateFallbackReason: string | null = null;
          let structuredRateResponseStatus: number | null = null;
          try {
            const params = new URLSearchParams({
              "filters[ZipCode][$eq]": zip,
              "filters[IsActive][$eq]": "true",
              "pagination[limit]": "1",
            });
            const response = await fetch(
              `${process.env.STRAPI_URL}/api/atlanta-delivery-zones?${params.toString()}`,
              {
                method: "GET",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.STRAPI_TOKEN}`,
                },
              },
            );
            structuredRateResponseStatus = response.status || null;
            if (response.ok) {
              const zone = strapiRow<AtlantaDeliveryZoneRate>(
                (await response.json())?.data?.[0],
              );
              if (zone) {
                return (
                  atlantaDeliveryRateCents(zone, eligibleSubtotalInCents) / 100
                );
              }
              structuredRateFallbackReason = "missing_active_zone";
            } else {
              structuredRateFallbackReason = "non_ok_response";
            }
          } catch (error) {
            structuredRateFallbackReason = "request_failed";
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger_.warn(
              `[fulfillment] failed to load structured Atlanta delivery rate for ${zip}; falling back to shipping-zones: ${message}`,
            );
            await emitOpsAlert({
              alertKind: "atlanta_delivery_structured_rate_fallback",
              title:
                "Atlanta delivery structured rate unavailable; using shipping-zone fallback",
              path: "src/modules/fulfillment/service.ts",
              source: "medusa",
              severity: "warn",
              logger: this.logger_,
              meta: {
                service_code: serviceCode,
                fallback: "shipping_zones",
                fallback_reason: structuredRateFallbackReason,
                destination_postal_code: zip,
                destination_province: state || null,
                item_count: items.length,
                eligible_subtotal: eligibleSubtotal,
                error_message: message.slice(0, 500),
              },
            });
            structuredRateFallbackReason = null;
          }

          if (structuredRateFallbackReason) {
            this.logger_.warn(
              `[fulfillment] structured Atlanta delivery rate ${structuredRateFallbackReason} for ${zip}; falling back to shipping-zones`,
            );
            await emitOpsAlert({
              alertKind: "atlanta_delivery_structured_rate_fallback",
              title:
                "Atlanta delivery structured rate unavailable; using shipping-zone fallback",
              path: "src/modules/fulfillment/service.ts",
              source: "medusa",
              severity: "warn",
              logger: this.logger_,
              meta: {
                service_code: serviceCode,
                fallback: "shipping_zones",
                fallback_reason: structuredRateFallbackReason,
                destination_postal_code: zip,
                destination_province: state || null,
                item_count: items.length,
                eligible_subtotal: eligibleSubtotal,
                response_status: structuredRateResponseStatus,
              },
            });
          }
        }

        let response: Response;
        let shippingZonesPayload: any = {};
        try {
          response = await fetch(
            `${process.env.STRAPI_URL}/api/shipping-zones?populate=*`,
            {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.STRAPI_TOKEN}`,
              },
            },
          );
          shippingZonesPayload = await response.json().catch(() => ({}));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger_.warn(
            `[fulfillment] failed to load shipping zones for service ${serviceCode || "unknown"}: ${message}`,
          );
          await emitOpsAlert({
            alertKind: "shipping_zone_catalog_unavailable",
            title: `Shipping zone catalog unavailable for ${serviceCode || "unknown"}`,
            path: "src/modules/fulfillment/service.ts",
            source: "medusa",
            severity: "warn",
            logger: this.logger_,
            meta: {
              service_code: serviceCode || null,
              destination_postal_code: zip || null,
              destination_province: state || null,
              item_count: items.length,
              error_message: message.slice(0, 500),
            },
          });
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `This shipping option isn’t available for ${zip || city || "this address"}. Please choose a different shipping option.`,
          );
        }

        let tierSet: any[] = [];
        let zoneIsPercent = false;
        let expeditedFallback: any | null = null;
        let expeditedFallbackIsPercent = false;
        const zones = shippingZonesPayload?.data;
        if (!response.ok || !Array.isArray(zones)) {
          this.logger_.warn(
            `[fulfillment] shipping zones response was unusable for service ${serviceCode || "unknown"}; surfacing NOT_ALLOWED`,
          );
          await emitOpsAlert({
            alertKind: "shipping_zone_catalog_unavailable",
            title: `Shipping zone catalog unavailable for ${serviceCode || "unknown"}`,
            path: "src/modules/fulfillment/service.ts",
            source: "medusa",
            severity: "warn",
            logger: this.logger_,
            meta: {
              service_code: serviceCode || null,
              destination_postal_code: zip || null,
              destination_province: state || null,
              item_count: items.length,
              response_status: response.status || null,
              response_ok: response.ok,
              has_data_array: Array.isArray(zones),
            },
          });
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `This shipping option isn’t available for ${zip || city || "this address"}. Please choose a different shipping option.`,
          );
        }
        for (let i = 0; i < zones.length; i++) {
          const z = zones[i];
          let validZone = false;

          if (serviceCode == "PICKUP" && z.ZoneCode == "Pick Up From Plant") {
            validZone = true;
          } else if (serviceCode == "ATLANTA_DELIVERY" && z.ZIPCode == zip) {
            validZone = true;
          } else if (
            serviceCode == "SCHEDULED_DELIVERY" &&
            !z.Zip &&
            z.City == city &&
            z.State == state
          ) {
            validZone = true;
          } else if (
            SHIPPING_ZONE_CODE_ALIASES[serviceCode] &&
            zoneCodeMatches(z.ZoneCode, SHIPPING_ZONE_CODE_ALIASES[serviceCode])
          ) {
            validZone = true;
          }

          if (
            EXPEDITED_UPS_SERVICE_CODES.has(serviceCode) &&
            zoneCodeMatches(z.ZoneCode, SHIPPING_ZONE_CODE_ALIASES.OVERNIGHT)
          ) {
            expeditedFallback = z;
            expeditedFallbackIsPercent =
              z.Description && z.Description.toUpperCase().includes("PERCENT");
          }

          if (validZone) {
            tierSet = z.ShippingZoneBreakpoints;
            zoneIsPercent =
              z.Description && z.Description.toUpperCase().includes("PERCENT");
            break;
          }
        }

        if (
          tierSet.length === 0 &&
          expeditedFallback?.ShippingZoneBreakpoints?.length
        ) {
          tierSet = expeditedFallback.ShippingZoneBreakpoints;
          zoneIsPercent = expeditedFallbackIsPercent;
        }

        let price: number | null = null;
        if (tierSet.length > 0) {
          tierSet.sort(
            (a: any, b: any) => a.BreakpointPrice - b.BreakpointPrice,
          );

          let matchedTier: any = tierSet[0];
          for (const tier of tierSet) {
            if (tier.BreakpointPrice <= eligibleSubtotal) {
              matchedTier = tier;
            }
          }

          const isUPSTier =
            serviceCode === "GROUND" ||
            EXPEDITED_UPS_SERVICE_CODES.has(serviceCode);

          if (zoneIsPercent) {
            price = (matchedTier.ShippingRate / 100) * eligibleSubtotal;
          } else if (isUPSTier && matchedTier.BreakpointPrice > 0) {
            price = (matchedTier.ShippingRate / 100) * eligibleSubtotal;
          } else {
            price = matchedTier.ShippingRate;
          }
        }

        if (price === null) {
          this.logger_.warn(
            `[fulfillment] no configured shipping rate tier matched service ${serviceCode || "unknown"} for ${zip || city || "unknown destination"}; surfacing NOT_ALLOWED`,
          );
          await emitOpsAlert({
            alertKind: "shipping_rate_tier_missing",
            title: `Shipping rate tier missing for ${serviceCode || "unknown"}; checkout blocked`,
            path: "src/modules/fulfillment/service.ts",
            source: "medusa",
            severity: "warn",
            logger: this.logger_,
            meta: {
              service_code: serviceCode || null,
              destination_postal_code: zip || null,
              destination_province: state || null,
              item_count: items.length,
              eligible_subtotal: eligibleSubtotal,
              zone_count: zones.length,
            },
          });
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `This shipping option isn’t available for ${zip || city || "this address"}. Please choose a different shipping option.`,
          );
        }

        return packingPlan ? compose("cms_fallback", price) : price;
      },
      create: async () => ({
        external_id: "SHIP-123",
        tracking_url: "https://track.example/SHIP-123",
      }),
      createReturn: async () => ({
        external_id: "RET-123",
        rma_label_url: "https://labels.example/RET-123.pdf",
      }),
      cancel: async () => {},
      getDocuments: async () => [
        { name: "label", url: "https://labels.example/SHIP-123.pdf" },
      ],
      getServices: async () => {
        return FULFILLMENT_SERVICES;
      },
    };
  }

  private async calculateWwexShippingRate(
    data: Record<string, unknown>,
    packingPlan?: ShippingPackingPlan,
  ): Promise<number | null> {
    if (!this.wwexClient) return null;

    const serviceCode = normalizeGrillersUpsServiceCode(data.service_code);
    if (!isUpsServiceCode(serviceCode)) return null;

    const rateInput = wwexRateInputFromFulfillmentData(
      serviceCode,
      data as Record<string, any>,
      packingPlan,
    );
    if (!rateInput) return null;

    try {
      const quote = await this.wwexClient.quoteSmallpack(rateInput);
      if (
        packingPlan?.arrivalDate &&
        ((quote.offer.transitDays != null &&
          quote.offer.transitDays !== packingPlan.transitDays) ||
          (quote.offer.estimatedDeliveryDate != null &&
            quote.offer.estimatedDeliveryDate.slice(0, 10) !==
              packingPlan.arrivalDate))
      )
        throw new FulfillmentCalendarError("carrier_promise_changed");
      if (
        quote.offer.price.currency.toLowerCase() !== "usd" ||
        !Number.isFinite(quote.offer.price.value) ||
        quote.offer.price.value < 0
      )
        throw new Error(
          "Carrier returned an invalid currency or freight amount",
        );
      return quote.offer.price.value;
    } catch (error) {
      if (error instanceof FulfillmentCalendarError)
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
      const message = error instanceof Error ? error.message : String(error);
      this.logger_.warn(
        `[wwex] live UPS ${serviceCode} quote failed; falling back to Strapi shipping zones: ${message}`,
      );
      const shippingAddress = (data.shipping_address || {}) as Record<
        string,
        unknown
      >;
      const items = Array.isArray(data.items) ? data.items : [];
      await emitOpsAlert({
        alertKind: "wwex_checkout_quote_failed",
        title: `WWEX checkout ${serviceCode} quote failed; using Strapi fallback`,
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        logger: this.logger_,
        meta: {
          service_code: serviceCode,
          fallback: "strapi_shipping_zones",
          destination_country: shippingAddress.country_code || null,
          destination_province: shippingAddress.province || null,
          item_count: items.length,
          error_message: message.slice(0, 500),
        },
      });
      return null;
    }
  }

  /** Boot-safe (re)load of the forecast model; never throws (fails open). */
  private reloadForecastModel(): void {
    const result = loadShippingCostForecastModelResult(process.env);
    this.shippingCostForecastModel = result.model;
    this.shippingForecastModelPath = result.path;
    this.shippingForecastModelMtimeMs = forecastModelFileMtimeMs(result.path);
    if (result.error) {
      this.logger_.warn(
        `[shipping-forecast] model unavailable (${result.error}); using WWEX/Strapi rates`,
      );
      void emitOpsAlert({
        alertKind: "shipping_forecast_model_unavailable",
        title:
          "Shipping forecast model unavailable; checkout using WWEX/Strapi fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "page",
        logger: this.logger_,
        meta: {
          model_path: result.path,
          error_message: result.error.slice(0, 500),
          fallback: "wwex_or_strapi",
        },
      });
    } else if (shippingForecastEnabled(process.env) && !result.model) {
      this.logger_.warn(
        "[shipping-forecast] enabled but no model path/model loaded; using WWEX/Strapi rates",
      );
      void emitOpsAlert({
        alertKind: "shipping_forecast_model_missing",
        title: "Shipping forecast is enabled without a loaded model",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "page",
        logger: this.logger_,
        meta: {
          model_path: result.path,
          fallback: "wwex_or_strapi",
        },
      });
    } else if (result.model) {
      this.logger_.info(
        `[shipping-forecast] loaded ${result.model.schema_version} model from ${result.path}`,
      );
    }
  }

  /**
   * Returns the active model, lazily hot-reloading when the model file's mtime
   * changes so a retrained model can be picked up without a full redeploy.
   */
  private getForecastModel(): ReturnType<typeof loadShippingCostForecastModel> {
    if (this.shippingForecastModelPath) {
      const mtime = forecastModelFileMtimeMs(this.shippingForecastModelPath);
      if (mtime !== null && mtime !== this.shippingForecastModelMtimeMs) {
        this.reloadForecastModel();
      }
    }
    return this.shippingCostForecastModel;
  }

  private calculateForecastShippingRate(
    data: Record<string, unknown>,
    packingPlan?: ShippingPackingPlan,
  ): { amount: number; rawFreight: number } | null {
    const model = this.getForecastModel();
    if (!model) return null;

    const serviceCode = normalizeGrillersUpsServiceCode(data.service_code);
    if (!isUpsServiceCode(serviceCode)) return null;

    const input = shippingForecastInputFromFulfillmentData(
      serviceCode,
      data as Record<string, any>,
      { resolvedWeights: packingPlan?.weights },
    );
    if (!input) return null;

    try {
      const forecast = forecastShippingCost(model, input);
      if (!forecast) {
        void emitOpsAlert({
          alertKind: "shipping_forecast_fallthrough",
          title:
            "Shipping forecast returned no prediction; checkout using WWEX/Strapi fallback",
          path: "src/modules/fulfillment/service.ts",
          source: "medusa",
          severity: "warn",
          logger: this.logger_,
          meta: {
            service_code: serviceCode,
            destination_postal_code: input.ship_postal_code,
            destination_province: input.ship_state,
            fallback: "wwex_or_strapi",
            reason: "no_prediction",
          },
        });
        return null;
      }
      const freightCharge = resolveForecastCharge(forecast, process.env);
      if (freightCharge === null) {
        void emitOpsAlert({
          alertKind: "shipping_forecast_fallthrough",
          title:
            "Shipping forecast outside confidence rails; checkout using WWEX/Strapi fallback",
          path: "src/modules/fulfillment/service.ts",
          source: "medusa",
          severity: "warn",
          logger: this.logger_,
          meta: {
            service_code: forecast.metadata.service,
            destination_postal_code: input.ship_postal_code,
            destination_province: input.ship_state,
            point_estimate: forecast.amount,
            residual_p75: forecast.confidence.residual_p75,
            min_usd:
              envNumber(process.env.GRILLERS_SHIPPING_FORECAST_MIN_USD) ??
              DEFAULT_MIN_FORECAST_USD,
            max_usd: forecastMaxUsd(process.env),
            fallback: "wwex_or_strapi",
            reason: "outside_confidence_rails",
          },
        });
      }

      // Only freight here. Packaging is composed once after source selection.
      const charge = freightCharge;
      const packaging = packingPlan;

      // Structured feedback log: pairs the predicted charge with order identity so
      // it can be reconciled against the eventual Unishippers actual cost (drift).
      this.logger_.info(
        `[shipping-forecast] ${JSON.stringify({
          service: forecast.metadata.service,
          ship_state: forecast.metadata.ship_state,
          point_estimate: forecast.amount,
          residual_p75: forecast.confidence.residual_p75,
          freight_charge: freightCharge,
          packaging: packaging
            ? {
                boxes: packaging.boxes,
                box_tier: packaging.packages[0].boxTier,
                packing_plan_id: packaging.id,
                policy_version: packaging.policyVersion,
                dry_ice_lb: packaging.dryIceLb,
                box_usd: packaging.boxCost,
                dry_ice_usd: packaging.dryIceCost,
              }
            : null,
          freight_basis: charge,
          confident: charge !== null,
          ref:
            (data as any)?.cart_id ||
            (data as any)?.id ||
            (data as any)?.shipping_address?.postal_code ||
            null,
        })}`,
      );
      // A non-confident forecast (degenerate / out-of-band) falls through to the
      // WWEX live quote and then the conservative Strapi tier table.
      return charge === null
        ? null
        : { amount: charge, rawFreight: forecast.amount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger_.warn(
        `[shipping-forecast] checkout shipping forecast failed; falling back to WWEX/Strapi rates: ${message}`,
      );
      void emitOpsAlert({
        alertKind: "shipping_forecast_fallthrough",
        title:
          "Shipping forecast threw during checkout; using WWEX/Strapi fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "page",
        logger: this.logger_,
        meta: {
          error_message: message.slice(0, 500),
          fallback: "wwex_or_strapi",
          reason: "exception",
        },
      });
      return null;
    }
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    // assuming you have a client
    const services = await this.client.getServices();

    return services.map((service) => ({
      id: service.id,
      name: service.name,
      service_code: service.code,
      // can add other relevant data for the provider to later process the shipping option.
    }));
  }

  async validateFulfillmentData(
    optionData: any,
    data: any,
    context: any,
  ): Promise<any> {
    const service = normalizeServiceCode(optionData?.service_code);
    const result = { ...data, service_code: service, externalId: 123 };
    delete result[SHIPPING_PACKING_PLAN_KEY];
    delete result.packages;
    if (isUpsServiceCode(service)) {
      try {
        const items = await loadShippingCatalogLines(
          this.shippingContainer_.query,
          context?.items ?? [],
        );
        const dates = await calendarPackingContextForRate(
          this.shippingContainer_.query,
          context?.id || context?.cart_id,
          service,
        );
        result[SHIPPING_PACKING_PLAN_KEY] = createShippingPackingPlan(
          items,
          dates,
          await getPackagingConfig(process.env),
        );
        readShippingPriceToken(
          data[SHIPPING_PRICE_TOKEN_KEY],
          { ...context, items },
          result[SHIPPING_PACKING_PLAN_KEY],
          await getShippingPricePolicy(),
        );
      } catch (error) {
        if (
          error instanceof ShippingInputError ||
          error instanceof FulfillmentCalendarError
        )
          throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
        throw error;
      }
    }
    return result;
  }

  /**
   * Called when Admin creates a *calculated* shipping option.
   * Return false to block creation (no live rates available).
   */
  async canCalculate(data: CreateShippingOptionDTO): Promise<boolean> {
    // Typically check carrier/rate availability based on option data
    const ok = await this.client.hasRates(String((data as any)?.id ?? ""));
    return ok;
  }

  /**
   * Calculates price for a shipping method (cart refresh or creation).
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"],
  ): Promise<CalculatedShippingOptionPrice> {
    const calculation = await this.client
      .calculate({
        ...optionData,
        ...data,
        ...context,
        // Service identity belongs to the configured option, never method data.
        service_code: (optionData as any)?.service_code,
      })
      .catch((error) => {
        if (error instanceof ShippingInputError)
          throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
        throw error;
      });
    const amount =
      typeof calculation === "number"
        ? calculation
        : calculation.quote.customerShippingBeforePromotions;
    const priceToken =
      typeof calculation === "number"
        ? null
        : issueShippingPriceToken(
            { ...optionData, ...data, ...context },
            calculation.plan,
            calculation.quote,
          );
    if (amount === -10) {
      // #251: the legacy sentinel means shipping failed open.
      await emitOpsAlert({
        alertKind: "shipping_calculate_price_sentinel",
        title: "Shipping calculatePrice returned -10 sentinel",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        logger: this.logger_,
        meta: {
          service_code: (optionData as any)?.service_code || null,
          postal_code:
            (data as any)?.shipping_address?.postal_code ||
            (context as any)?.shipping_address?.postal_code ||
            null,
        },
      });
    }
    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: true,
      ...(priceToken ? { [SHIPPING_PRICE_TOKEN_KEY]: priceToken } : {}),
    };
  }

  /**
   * Create an outbound fulfillment with your 3rd-party service.
   * Anything you return in `data` is persisted on the Fulfillment in Medusa.
   */
  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >,
  ): Promise<CreateFulfillmentResult> {
    const externalData = await this.client.create(fulfillment, items);

    // You can also return labels here as part of the result if available.
    return {
      labels: [],
      data: {
        // @ts-ignore
        ...(fulfillment.data as object | undefined),
        ...externalData,
      },
      // labels: [{ tracking_number: "...", label_url: "...", ... }]
    };
  }

  /**
   * Create a return fulfillment (RMA label, etc.)
   */
  async createReturnFulfillment(
    fulfillment: Record<string, unknown>,
  ): Promise<CreateFulfillmentResult> {
    const externalData = await this.client.createReturn(fulfillment);
    return {
      labels: [],
      data: { ...externalData },
      // labels: [{ label_url: externalData.rma_label_url }]
    };
  }

  /**
   * Cancel a fulfillment with your 3rd-party service.
   */
  async cancelFulfillment(data: Record<string, unknown>): Promise<any> {
    const { external_id } = (data || {}) as { external_id?: string };
    if (external_id) {
      await this.client.cancel(external_id);
    } else {
      this.logger_.warn(
        "[grillers] cancelFulfillment called without external_id",
      );
    }
  }

  /**
   * Return artifacts (labels, invoices, etc.) for a fulfillment.
   */
  async getFulfillmentDocuments(data: any): Promise<never[]> {
    // assuming the client retrieves documents
    // from a third-party service
    // @ts-ignore
    return await this.client.getDocuments(data);
  }
}
