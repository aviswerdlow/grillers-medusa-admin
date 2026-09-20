import {
  createWwexSpeedshipClientFromEnv,
  normalizeGrillersUpsServiceCode,
} from "../wwex-speedship"
import { wwexRateInputFromFulfillmentData } from "../wwex-speedship"
import { createShippingPackingPlan } from "../../../lib/shipping-packing-plan"
import { shippingLine,packingConfig } from "../../../lib/__tests__/__fixtures__/shipping-inputs"

const env = {
  WWEX_AUTH_URL: "https://auth.example.test/oauth/token",
  WWEX_API_BASE_URL: "https://speedship.example.test/svc",
  WWEX_CLIENT_ID: "client_id",
  WWEX_CLIENT_SECRET: "client_secret",
  WWEX_AUDIENCE: "audience",
  WWEX_ORIGIN_ADDRESS_1: "123 Plant Rd",
  WWEX_ORIGIN_CITY: "Doraville",
  WWEX_ORIGIN_STATE: "GA",
  WWEX_ORIGIN_POSTAL_CODE: "30340",
  WWEX_ORIGIN_PHONE: "7704548108",
}

function response(body: Record<string, any>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

describe("WwexSpeedshipClient", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it("normalizes Griller's UPS service names", () => {
    expect(normalizeGrillersUpsServiceCode("UPS Ground")).toBe("GROUND")
    expect(normalizeGrillersUpsServiceCode("UPS 3 Day Select")).toBe(
      "3_DAY_SELECT"
    )
    expect(normalizeGrillersUpsServiceCode("UPS 2nd Day Air")).toBe(
      "2ND_DAY_AIR"
    )
    expect(normalizeGrillersUpsServiceCode("UPS Overnight")).toBe("OVERNIGHT")
  })

  it("quotes a requested service from Speedship offers", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({ access_token: "token", expires_in: 86400 })
      )
      .mockResolvedValueOnce(
        response({
          clientStatus: { success: true },
          response: {
            offerList: [
              {
                offerId: "offer-ground",
                productTransactionId: "ptr-ground",
                offeredProductList: [
                  {
                    offerPrice: { value: 17.59, unit: "USD" },
                    shopRQShipment: {
                      timeInTransit: {
                        upsServiceCode: "GND",
                        transitDays: 1,
                        estimatedDeliveryDate: "2026-06-17",
                      },
                    },
                  },
                ],
              },
              {
                offerId: "offer-3ds",
                productTransactionId: "ptr-3ds",
                offeredProductList: [
                  {
                    offerPrice: { value: 22.99, unit: "USD" },
                    shopRQShipment: {
                      timeInTransit: {
                        upsServiceCode: "3DS",
                        transitDays: 3,
                        estimatedDeliveryDate: "2026-06-19",
                      },
                    },
                  },
                ],
              },
            ],
          },
        })
      )

    const client = createWwexSpeedshipClientFromEnv(env)
    const quote = await client!.quoteSmallpack({
      serviceCode: "3_DAY_SELECT",
      shippingAddress: {
        address_1: "3838 Oak Lawn Ave",
        city: "Highland Park",
        province: "TX",
        postal_code: "75219",
        country_code: "US",
        first_name: "Test",
        last_name: "Customer",
        phone: "2148798521",
      },
      packages: [{ package_type: "Micro", packed_weight_lb: 5, length_in:10, width_in:11, height_in:12 }],
      shipmentDate: "2026-06-16",
    })

    expect(quote.offer).toMatchObject({
      offerId: "offer-3ds",
      productTransactionId: "ptr-3ds",
      upsServiceCode: "3DS",
      price: { value: 22.99, currency: "USD" },
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body)).toMatchObject({
      request: {
        productType: "SMALLPACK",
        shipment: {
          destinationAddress: {
            address: {
              postalCode: "75219",
              region: "TX",
            },
          },
          totalWeight: { value: 5, unit: "LB" },
        },
      },
    })
  })

  it("stays disabled until the required environment is present", () => {
    expect(createWwexSpeedshipClientFromEnv({})).toBeNull()
  })

  it("uses the shared plan's physical contents plus ice/tare and ignores forged checkout packages",()=>{
    const plan=createShippingPackingPlan([shippingLine({quantity:2})],{service:"GROUND",postalCode:"30340",validatedTransit:{days:1,revision:"test"}},packingConfig());
    const data={shipping_address:{postal_code:"30340",city:"Doraville",province:"GA"},items:[shippingLine({quantity:2})],packages:[{packed_weight_lb:1}]};
    const input=wwexRateInputFromFulfillmentData("GROUND",data,plan)!;
    const request=createWwexSpeedshipClientFromEnv(env)!.buildShopRequest(input);
    expect(request.request.shipment.totalWeight).toEqual({value:9,unit:"LB"});
    expect(request.request.shipment.handlingUnitList).toHaveLength(2);
    expect(input.packages).toBeUndefined();
    const measured={...input,packages:[{packed_weight_lb:14,length_in:15,width_in:14,height_in:13}]};
    expect(createWwexSpeedshipClientFromEnv(env)!.buildShopRequest(measured).request.shipment.totalWeight).toEqual({value:14,unit:"LB"});
    expect(plan.packages[0].grossWeightLb).toBe(4.5);
  });

  it.each([undefined,0,-1,"n/a"])("rejects missing/invalid measured gross %p instead of defaulting to one pound",weight=>{
    const input:any={serviceCode:"GROUND",shippingAddress:{postal_code:"30340",city:"Doraville",province:"GA"},packages:[{packed_weight_lb:weight,length_in:10,width_in:10,height_in:10}]};
    expect(()=>createWwexSpeedshipClientFromEnv(env)!.buildShopRequest(input)).toThrow();
  });

  it("rejects missing package dimensions or an absent estimate",()=>{
    const input:any={serviceCode:"GROUND",shippingAddress:{postal_code:"30340",city:"Doraville",province:"GA"},items:[{quantity:1}]};
    const client=createWwexSpeedshipClientFromEnv(env)!;
    expect(()=>client.buildShopRequest(input)).toThrow();
    expect(()=>client.buildShopRequest({...input,packages:[{packed_weight_lb:5}]})).toThrow();
  });
})
