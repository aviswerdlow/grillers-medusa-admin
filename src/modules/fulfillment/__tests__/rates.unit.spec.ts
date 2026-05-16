import {
  atlantaDeliveryRateCents,
  eligibleSubtotalCents,
  lineItemQualifiesForFreeDelivery,
} from "../rates"

describe("fulfillment rates", () => {
  it("defaults line items to eligible for free delivery progress", () => {
    expect(lineItemQualifiesForFreeDelivery({ metadata: {} })).toBe(true)
    expect(
      lineItemQualifiesForFreeDelivery({
        metadata: { free_delivery_eligible: false },
      })
    ).toBe(false)
  })

  it("calculates checkout rate tiers from eligible subtotal only", () => {
    expect(
      eligibleSubtotalCents([
        { unit_price: 10000, quantity: 2, metadata: {} },
        {
          unit_price: 10000,
          quantity: 1,
          metadata: { free_delivery_eligible: false },
        },
      ])
    ).toBe(20000)
  })

  it("maps Atlanta delivery structured tiers", () => {
    const zone = {
      FreeDeliveryThresholdCents: 25000,
      Rate250PlusCents: 0,
      Rate150To249Cents: 2250,
      Rate100To149Cents: 2500,
      Rate50To99Cents: 2750,
      Rate0To49Cents: 3000,
    }

    expect(atlantaDeliveryRateCents(zone, 25000)).toBe(0)
    expect(atlantaDeliveryRateCents(zone, 20000)).toBe(2250)
    expect(atlantaDeliveryRateCents(zone, 12500)).toBe(2500)
    expect(atlantaDeliveryRateCents(zone, 7500)).toBe(2750)
    expect(atlantaDeliveryRateCents(zone, 4999)).toBe(3000)
  })
})
