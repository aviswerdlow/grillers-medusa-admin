// src/modules/grillers-fulfillment/service.ts
import {
  AbstractFulfillmentProviderService,
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
  eligibleSubtotalCents,
  type AtlantaDeliveryZoneRate,
} from "./rates";

type InjectedDependencies = {
  logger: Logger;
};

type Options = {
  apiKey?: string;
  endpoint?: string;
};

function strapiRow<T extends Record<string, unknown>>(row: unknown): T | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  return ((value.attributes as T | undefined) || (value as T)) ?? null;
}

export default class GrillersFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "grillers-fulfillment"; // => stored as fp_grillers_<id> in DB

  protected logger_: Logger;
  protected options_: Options;
  protected strapiSvc: any;

  // Example: your external shipper SDK/client
  protected client: {
    hasRates: (optionId: string) => Promise<boolean>;
    calculate: (data: Record<string, unknown>) => Promise<number>;
    create: (
      fulfillment: Partial<
        Omit<FulfillmentDTO, "provider_id" | "data" | "items">
      >,
      items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[]
    ) => Promise<Record<string, unknown>>;
    createReturn: (
      fulfillment: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    cancel: (externalId: string) => Promise<void>;
    getDocuments: (
      externalId: string
    ) => Promise<Array<{ name: string; url: string }>>;
    getServices: () => Promise<
      Array<{ id: string; name: string; code: string }>
    >;
  };

  constructor(container: any, options: Options) {
    super();
    this.logger_ = container.logger;
    this.options_ = options;
    this.logger_.info("GrillersFulfillmentProviderService loaded");
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
        const serviceCode: string | any = optionData?.service_code;
        const items = Array.isArray(optionData?.items) ? optionData.items : [];

        const total = eligibleSubtotalCents(items);

        if (serviceCode == "ATLANTA_DELIVERY" && zip) {
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
              }
            );
            if (response.ok) {
              const zone = strapiRow<AtlantaDeliveryZoneRate>(
                (await response.json())?.data?.[0]
              );
              if (zone) {
                return atlantaDeliveryRateCents(zone, total);
              }
            }
          } catch (error) {
            this.logger_.warn(
              `[fulfillment] failed to load structured Atlanta delivery rate for ${zip}; falling back to shipping-zones`
            );
          }
        }

        const response = await fetch(
          `${process.env.STRAPI_URL}/api/shipping-zones?populate=*`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.STRAPI_TOKEN}`,
            },
          }
        );

        let tierSet: any[] = [];
        let zoneIsPercent = false;
        const zones = (await response.json())?.data;
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
          } else if (serviceCode == "GROUND" && z.ZoneCode == "FedexGround") {
            validZone = true;
          } else if (
            serviceCode == "OVERNIGHT" &&
            z.ZoneCode == "FedexOvernight"
          ) {
            validZone = true;
          }

          if (validZone) {
            tierSet = z.ShippingZoneBreakpoints;
            zoneIsPercent =
              z.Description &&
              z.Description.toUpperCase().includes("PERCENT");
            break;
          }
        }

        let price = -10;
        if (tierSet.length > 0) {
          tierSet.sort(
            (a: any, b: any) => a.BreakpointPrice - b.BreakpointPrice
          );

          let matchedTier: any = tierSet[0];
          for (const tier of tierSet) {
            if (tier.BreakpointPrice <= total) {
              matchedTier = tier;
            }
          }

          const isUPSTier =
            serviceCode === "GROUND" || serviceCode === "OVERNIGHT";

          if (zoneIsPercent) {
            price = (matchedTier.ShippingRate / 100) * total;
          } else if (isUPSTier && matchedTier.BreakpointPrice > 0) {
            price = (matchedTier.ShippingRate / 100) * total;
          } else {
            price = matchedTier.ShippingRate;
          }
        }

        return price;
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
        return [
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
            name: "Ground Estimated Shipping",
            code: "GROUND",
          },
          {
            id: "overnight",
            name: "Overnight Estimated Shipping",
            code: "OVERNIGHT",
          },
        ];
      },
    };
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
    context: any
  ): Promise<any> {
    // assuming your client retrieves an ID from the
    // third-party service
    const externalId = 123; //await this.client.getId();

    return {
      ...data,
      externalId,
    };
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
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const amount = await this.client.calculate({
      ...optionData,
      ...data,
      ...context,
    });
    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: true,
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
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
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
    fulfillment: Record<string, unknown>
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
        "[grillers] cancelFulfillment called without external_id"
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
