import { ShippingInputError } from "../../lib/shipping-weights"
import type { ShippingPackingPlan } from "../../lib/shipping-packing-plan"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type EnvLike = Record<string, string | undefined>

export type GrillersUpsServiceCode =
  | "GROUND"
  | "3_DAY_SELECT"
  | "2ND_DAY_AIR"
  | "OVERNIGHT"

export type WwexMoney = {
  value: number
  currency: string
}

export type WwexAddressInput = {
  address_1?: string | null
  address_2?: string | null
  address_3?: string | null
  city?: string | null
  province?: string | null
  province_code?: string | null
  state?: string | null
  postal_code?: string | null
  country_code?: string | null
  company?: string | null
  company_name?: string | null
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  email?: string | null
}

export type WwexPackageInput = {
  id?: string | null
  package_type?: string | null
  packed_weight_lb?: number | string | null
  dry_ice_lb?: number | string | null
  length_in?: number | string | null
  width_in?: number | string | null
  height_in?: number | string | null
  reference?: string | null
  note?: string | null
}

export type WwexRateInput = {
  estimatedPackingPlan?: ShippingPackingPlan
  serviceCode: string
  shippingAddress: WwexAddressInput
  items?: Array<Record<string, any>>
  packages?: WwexPackageInput[]
  shipmentDate?: string | Date | null
  orderDisplayId?: string | number | null
  orderId?: string | null
  residentialDelivery?: boolean
}

export type WwexOffer = {
  offerId: string
  productTransactionId: string
  upsServiceCode: string
  price: WwexMoney
  transitDays?: number | null
  estimatedDeliveryDate?: string | null
  deliveryBy?: string | null
  raw: Record<string, any>
}

export type WwexQuoteResult = {
  offer: WwexOffer
  offers: WwexOffer[]
  request: Record<string, any>
  response: Record<string, any>
}

export type WwexBookingInput = {
  quote: WwexQuoteResult
  sendersReceiptFlag?: boolean
  notificationEmails?: string[]
}

export type WwexBookingResult = {
  status: "booked"
  offerId: string
  productTransactionId: string
  upsServiceCode: string
  price: WwexMoney
  trackingNumber?: string | null
  raw: Record<string, any>
}

export type WwexDocumentResult = {
  status: "available"
  productTransactionId: string
  raw: Record<string, any>
}

type WwexSpeedshipConfig = {
  authUrl: string
  apiBaseUrl: string
  clientId: string
  clientSecret: string
  audience: string
  originAddress: Required<
    Pick<
      WwexAddressInput,
      "address_1" | "city" | "postal_code" | "country_code" | "phone"
    >
  > &
    WwexAddressInput
  billToAccountNbr?: string | null
  billToPostalCode?: string | null
  billToCountryCode?: string | null
  billToType?: string | null
  packageDimensions: Record<string, PackageDimensions>
  defaultPackage: PackageDimensions
  maxPackageWeightLb: number
  insuranceRequestFlag: boolean
  handlingCharge?: { value: string; unit: "AMOUNT" | "PERCENT" } | null
}

type PackageDimensions = {
  length: number | null
  width: number | null
  height: number | null
}

type TokenState = {
  accessToken: string
  expiresAt: number
}

const UPS_SERVICE_CODE_GROUPS: Record<GrillersUpsServiceCode, string[]> = {
  GROUND: ["GND"],
  "3_DAY_SELECT": ["3DS"],
  "2ND_DAY_AIR": ["2DA", "2DM"],
  OVERNIGHT: ["1DA", "1DM", "1DP"],
}

const DEFAULT_PACKAGE: PackageDimensions = {
  length: null,
  width: null,
  height: null,
}

const numberOrNull = (value: unknown): number | null => {
  if (value && typeof value === "object" && "value" in value) return numberOrNull((value as any).value)
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || (typeof value === "string" && !value.trim())) return null
  const parsed =
    typeof value === "object" && value !== null && "value" in value
      ? Number((value as Record<string, unknown>).value)
      : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const positiveNumber = (value: unknown): number | null => {
  const parsed = numberOrNull(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

const envText = (env: EnvLike, ...names: string[]): string => {
  for (const name of names) {
    const value = env[name]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

const envBool = (env: EnvLike, name: string, fallback = false): boolean => {
  const raw = env[name]
  if (raw === undefined || raw === null || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

const cleanPhone = (phone?: string | null): string =>
  String(phone || "")
    .replace(/[^\d+]/g, "")
    .slice(0, 15) || "0000000000"

const cleanPostalCode = (postalCode?: string | null): string =>
  String(postalCode || "")
    .trim()
    .slice(0, 10)

const cleanCountryCode = (countryCode?: string | null): string =>
  String(countryCode || "US")
    .trim()
    .toUpperCase()
    .slice(0, 2) || "US"

const truncate = (value: unknown, limit: number): string => {
  const text = String(value || "").trim()
  return text.length > limit ? text.slice(0, limit) : text
}

const dateToWwex = (value?: string | Date | null): string => {
  const date =
    value instanceof Date
      ? value
      : value
        ? new Date(`${String(value).slice(0, 10)}T00:00:00`)
        : new Date()
  if (Number.isNaN(date.getTime())) {
    return dateToWwex(new Date())
  }
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd} 00:00:00`
}

export function normalizeGrillersUpsServiceCode(
  serviceCode: unknown
): string {
  const normalized = String(serviceCode || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_")

  if (!normalized) return ""
  if (normalized.includes("GROUND") || normalized === "GND") return "GROUND"
  if (normalized.includes("3_DAY") || normalized.includes("3DS")) {
    return "3_DAY_SELECT"
  }
  if (
    normalized.includes("2ND_DAY") ||
    normalized.includes("SECOND_DAY") ||
    normalized.includes("2DA") ||
    normalized.includes("2DM")
  ) {
    return "2ND_DAY_AIR"
  }
  if (
    normalized.includes("OVERNIGHT") ||
    normalized.includes("NEXT_DAY") ||
    normalized.includes("1DA") ||
    normalized.includes("1DM") ||
    normalized.includes("1DP")
  ) {
    return "OVERNIGHT"
  }
  return normalized
}

export function isUpsServiceCode(serviceCode: unknown): boolean {
  return Object.keys(UPS_SERVICE_CODE_GROUPS).includes(
    normalizeGrillersUpsServiceCode(serviceCode)
  )
}

function wwexServiceCodesFor(serviceCode: unknown): string[] {
  const normalized = normalizeGrillersUpsServiceCode(serviceCode)
  return UPS_SERVICE_CODE_GROUPS[normalized as GrillersUpsServiceCode] || []
}

function parseDimensions(raw?: string): Record<string, PackageDimensions> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }

    return Object.entries(parsed).reduce<Record<string, PackageDimensions>>(
      (result, [key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return result
        }
        const record = value as Record<string, unknown>
        result[key.trim().toUpperCase()] = {
          length: positiveNumber(record.length) ?? null,
          width: positiveNumber(record.width) ?? null,
          height: positiveNumber(record.height) ?? null,
        }
        return result
      },
      {}
    )
  } catch {
    return {}
  }
}

function addressLineList(address: WwexAddressInput): string[] {
  return [address.address_1, address.address_2, address.address_3]
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 3)
}

function contactName(address: WwexAddressInput): {
  firstName: string
  lastName: string
} {
  const firstName = truncate(address.first_name, 15)
  const lastName = truncate(address.last_name || address.company_name || address.company, 35)
  if (lastName) return { firstName, lastName }
  return { firstName: "", lastName: "Customer" }
}

function speedshipAddress(address: WwexAddressInput, contactType: string) {
  const name = contactName(address)
  return {
    addressLineList: addressLineList(address),
    locality: truncate(address.city, 35),
    region: truncate(address.province_code || address.province || address.state, 2).toUpperCase(),
    postalCode: cleanPostalCode(address.postal_code),
    countryCode: cleanCountryCode(address.country_code),
    companyName: truncate(address.company_name || address.company || name.lastName, 35),
    phone: cleanPhone(address.phone),
    contactList: [
      {
        firstName: name.firstName,
        lastName: name.lastName,
        phone: cleanPhone(address.phone),
        contactType,
        email: truncate(address.email, 80),
        extension: null,
      },
    ],
  }
}

function packageTypeKey(value?: string | null): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
}

function dimensionsForPackage(
  pkg: WwexPackageInput,
  config: WwexSpeedshipConfig
): PackageDimensions {
  const explicit = {
    length: positiveNumber(pkg.length_in),
    width: positiveNumber(pkg.width_in),
    height: positiveNumber(pkg.height_in),
  }
  if ([pkg.length_in,pkg.width_in,pkg.height_in].some(v=>v!==undefined && v!==null)) {
    return explicit
  }

  const key = packageTypeKey(pkg.package_type)
  return config.packageDimensions[key] || config.defaultPackage
}

function estimatedPackages(
  input: WwexRateInput,
  config: WwexSpeedshipConfig
): WwexPackageInput[] {
  if (Array.isArray(input.packages) && input.packages.length) {
    return input.packages
  }

  const plan = input.estimatedPackingPlan
  if (!plan?.packages.length) throw new ShippingInputError("missing_packing_plan")
  return plan.packages.map((p,index)=>({package_type:p.boxName,packed_weight_lb:p.grossWeightLb,dry_ice_lb:p.dryIceLb,length_in:p.lengthIn,width_in:p.widthIn,height_in:p.heightIn,reference:`Estimate ${index+1}`}))
}

function handlingUnit(
  pkg: WwexPackageInput,
  index: number,
  config: WwexSpeedshipConfig,
  input: WwexRateInput
) {
  const dimensions = dimensionsForPackage(pkg, config)
  const weight = positiveNumber(pkg.packed_weight_lb)
  if (!weight || weight > config.maxPackageWeightLb) throw new ShippingInputError("invalid_packed_gross_weight")
  if (!dimensions.length || !dimensions.width || !dimensions.height) throw new ShippingInputError("missing_package_dimensions")
  const referenceBase = truncate(
    pkg.reference ||
      pkg.id ||
      (input.orderDisplayId ? `Order ${input.orderDisplayId}` : input.orderId) ||
      `Package ${index + 1}`,
    35
  )

  return {
    billedDimension: {
      length: { value: dimensions.length, unit: "in" },
      width: { value: dimensions.width, unit: "in" },
      height: { value: dimensions.height, unit: "in" },
      dimensionType: "NET",
    },
    packagingType: "02",
    packagingTypeName: "Custom",
    quantity: 1,
    referenceList: [
      {
        type: "Reference 1",
        value: referenceBase || `Package ${index + 1}`,
        description: null,
        isPrintAsBarCode: false,
      },
    ],
    shippedItemList: [
      {
        additionalHandlingFeeFlag: false,
      },
    ],
    weight: {
      unit: "LB",
      value: weight,
    },
    handlingGroup: "",
    totalWeight: {},
    saveToMyPackages: false,
    isLargePackage: false,
    additionalHandlingFeeFlag: false,
  }
}

function buildShipment(
  input: WwexRateInput,
  config: WwexSpeedshipConfig
) {
  const packages = estimatedPackages(input, config)
  const handlingUnitList = packages.map((pkg, index) =>
    handlingUnit(pkg, index, config, input)
  )
  const totalWeight = handlingUnitList.reduce(
    (sum, unit) => sum + Number(unit.weight.value || 0),
    0
  )

  return {
    adultSignatureRequiredFlag: false,
    destinationAddress: {
      address: speedshipAddress(input.shippingAddress, "RECEIVER"),
    },
    ...(config.handlingCharge ? { handlingCharge: config.handlingCharge } : {}),
    handlingUnitList,
    insuranceRequestFlag: config.insuranceRequestFlag,
    isCarbonNeutral: false,
    isCOD: false,
    sendersReceipt: true,
    isSignatureRequired: false,
    classAlertIndicator: "",
    isSelfScheduled: false,
    originAddress: {
      stopSequence: null,
      address: speedshipAddress(config.originAddress, "SENDER"),
    },
    residentialDeliveryFlag: input.residentialDelivery ?? true,
    returnLabelFlag: false,
    returnServiceType: null,
    shipmentDate: dateToWwex(input.shipmentDate),
    shipperReleaseFlag: false,
    totalHandlingUnitCount: handlingUnitList.length,
    totalWeight: {
      value: totalWeight,
      unit: "LB",
    },
    returnDescription: "Return Package",
    selectedServiceType: "",
    isSaturdayAvailable: false,
    skipAddressVerification: false,
  }
}

function extractOfferPrice(product: Record<string, any>): WwexMoney | null {
  const raw = product.offerPrice || product.price || product.total
  const value = positiveNumber(raw?.value ?? raw)
  if (!value) return null
  return {
    value,
    currency: String(raw?.unit || raw?.currency || "USD").toUpperCase(),
  }
}

function extractUpsServiceCode(product: Record<string, any>, offer: Record<string, any>): string {
  return String(
    product.shopRQShipment?.timeInTransit?.upsServiceCode ||
      product.timeInTransit?.upsServiceCode ||
      product.upsServiceCode ||
      product.serviceCode ||
      product.serviceType ||
      offer.upsServiceCode ||
      offer.serviceCode ||
      ""
  )
    .trim()
    .toUpperCase()
}

function extractOffers(response: Record<string, any>): WwexOffer[] {
  const offerList = Array.isArray(response?.response?.offerList)
    ? response.response.offerList
    : Array.isArray(response?.offerList)
      ? response.offerList
      : []

  return offerList.flatMap((offer: Record<string, any>) => {
    const products = Array.isArray(offer.offeredProductList)
      ? offer.offeredProductList
      : Array.isArray(offer.products)
        ? offer.products
        : [offer]

    return products.flatMap((product: Record<string, any>) => {
      const price = extractOfferPrice(product)
      const offerId = String(offer.offerId || product.offerId || "").trim()
      const productTransactionId = String(
        offer.productTransactionId || product.productTransactionId || ""
      ).trim()
      const upsServiceCode = extractUpsServiceCode(product, offer)
      if (!price || !offerId || !productTransactionId || !upsServiceCode) {
        return []
      }

      return [
        {
          offerId,
          productTransactionId,
          upsServiceCode,
          price,
          transitDays:
            numberOrNull(product.shopRQShipment?.timeInTransit?.transitDays) ??
            numberOrNull(product.timeInTransit?.transitDays),
          estimatedDeliveryDate:
            product.shopRQShipment?.timeInTransit?.estimatedDeliveryDate ||
            product.timeInTransit?.estimatedDeliveryDate ||
            null,
          deliveryBy:
            product.shopRQShipment?.timeInTransit?.deliveryBy ||
            product.timeInTransit?.deliveryBy ||
            null,
          raw: offer,
        },
      ]
    })
  })
}

function selectedOffer(serviceCode: unknown, offers: WwexOffer[]): WwexOffer | null {
  const acceptable = new Set(wwexServiceCodesFor(serviceCode))
  if (!acceptable.size) return null
  const candidates = offers.filter((offer) => acceptable.has(offer.upsServiceCode))
  return candidates.sort((a, b) => a.price.value - b.price.value)[0] || null
}

function trackingNumberFrom(raw: Record<string, any>): string | null {
  const text = JSON.stringify(raw)
  const match = text.match(/\b1Z[A-Z0-9]{10,24}\b/i)
  return match?.[0] || null
}

export class WwexSpeedshipClient {
  private token: TokenState | null = null

  constructor(
    private readonly config: WwexSpeedshipConfig,
    private readonly logger?: LoggerLike
  ) {}

  private endpoint(path: string): string {
    return `${this.config.apiBaseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      audience: this.config.audience,
    })
    const response = await fetch(this.config.authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok || !json?.access_token) {
      throw new Error(
        `WWEX auth failed with HTTP ${response.status}: ${
          json?.error_description || json?.error || "missing access token"
        }`
      )
    }

    this.token = {
      accessToken: json.access_token,
      expiresAt: Date.now() + Math.max(60, Number(json.expires_in || 3600)) * 1000,
    }
    return this.token.accessToken
  }

  private async post(path: string, body: Record<string, any>) {
    const token = await this.accessToken()
    const response = await fetch(this.endpoint(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok || json?.clientStatus?.success === false) {
      const message =
        json?.clientStatus?.message ||
        json?.message ||
        json?.error_description ||
        json?.error ||
        `HTTP ${response.status}`
      throw new Error(`WWEX ${path} failed: ${message}`)
    }
    return json
  }

  buildShopRequest(input: WwexRateInput): Record<string, any> {
    return {
      request: {
        productType: "SMALLPACK",
        shipment: buildShipment(input, this.config),
      },
    }
  }

  async quoteSmallpack(input: WwexRateInput): Promise<WwexQuoteResult> {
    const request = this.buildShopRequest(input)
    const response = await this.post("shopFlow", request)
    const offers = extractOffers(response)
    const offer = selectedOffer(input.serviceCode, offers)

    if (!offer) {
      throw new Error(
        `WWEX did not return a ${normalizeGrillersUpsServiceCode(
          input.serviceCode
        )} offer. Returned services: ${
          offers.map((candidate) => candidate.upsServiceCode).join(", ") || "none"
        }`
      )
    }

    return { offer, offers, request, response }
  }

  async bookSmallpack(input: WwexBookingInput): Promise<WwexBookingResult> {
    if (!this.config.billToAccountNbr || !this.config.billToPostalCode) {
      throw new Error(
        "WWEX booking requires WWEX_BILL_TO_ACCOUNT_NBR and WWEX_BILL_TO_POSTAL_CODE."
      )
    }

    const notificationEmails = (input.notificationEmails || [])
      .map((email) => email.trim())
      .filter(Boolean)

    const request: Record<string, any> = {
      request: {
        ...(notificationEmails.length
          ? {
              mode: "SAVE",
              notificationGroups: [
                {
                  notificationSource: "CUSTOM_SHIPMENT_PREFERENCE",
                  notificationGroupId: input.quote.offer.productTransactionId,
                  shipmentNotificationPreference: {
                    emailList: notificationEmails,
                    alertTypeList: [
                      "shipment.exception",
                      "shipment.shipment_booked",
                      "shipment.shipment_delivered",
                      "shipment.shipment_in_transit",
                      "shipment.shipment_out_for_delivery",
                      "shipment.shipment_pickup_scheduled",
                      "shipment.shipment_voided",
                    ],
                  },
                },
              ],
            }
          : {}),
        orderRQList: [
          {
            offerId: input.quote.offer.offerId,
            productTransactionId: input.quote.offer.productTransactionId,
            billToAccountNbr: this.config.billToAccountNbr,
            billToPostalCode: this.config.billToPostalCode,
            billToType: this.config.billToType || "SENDER",
            billToCountryCode: this.config.billToCountryCode || "US",
            sendersReceiptFlag: input.sendersReceiptFlag ?? false,
          },
        ],
      },
    }

    const raw = await this.post("integratedOrderFlow", request)
    return {
      status: "booked",
      offerId: input.quote.offer.offerId,
      productTransactionId: input.quote.offer.productTransactionId,
      upsServiceCode: input.quote.offer.upsServiceCode,
      price: input.quote.offer.price,
      trackingNumber: trackingNumberFrom(raw),
      raw,
    }
  }

  async downloadSmallpackLabel(
    productTransactionId: string
  ): Promise<WwexDocumentResult> {
    const raw = await this.post("documentDownloadFlow", {
      request: {
        downloadMode: "SINGLE",
        docTypes: ["UPS_LABEL_ONLY"],
        transactionType: "SMALLPACK",
        referenceMap: {
          PRODUCT_TRANSACTION_ID: productTransactionId,
        },
      },
    })

    return {
      status: "available",
      productTransactionId,
      raw,
    }
  }
}

export function createWwexSpeedshipClientFromEnv(
  env: EnvLike = process.env,
  logger?: LoggerLike
): WwexSpeedshipClient | null {
  if (envBool(env, "WWEX_DISABLED", false)) return null

  const authUrl = envText(env, "WWEX_AUTH_URL")
  const apiBaseUrl = envText(env, "WWEX_API_BASE_URL")
  const clientId = envText(env, "WWEX_CLIENT_ID")
  const clientSecret = envText(env, "WWEX_CLIENT_SECRET")
  const audience = envText(env, "WWEX_AUDIENCE")
  const originAddress = {
    address_1: envText(env, "WWEX_ORIGIN_ADDRESS_1", "GRILLERS_SHIP_FROM_ADDRESS_1"),
    address_2: envText(env, "WWEX_ORIGIN_ADDRESS_2", "GRILLERS_SHIP_FROM_ADDRESS_2"),
    address_3: envText(env, "WWEX_ORIGIN_ADDRESS_3", "GRILLERS_SHIP_FROM_ADDRESS_3"),
    city: envText(env, "WWEX_ORIGIN_CITY", "GRILLERS_SHIP_FROM_CITY"),
    province: envText(env, "WWEX_ORIGIN_STATE", "GRILLERS_SHIP_FROM_STATE"),
    postal_code: envText(
      env,
      "WWEX_ORIGIN_POSTAL_CODE",
      "GRILLERS_SHIP_FROM_POSTAL_CODE"
    ),
    country_code: envText(env, "WWEX_ORIGIN_COUNTRY_CODE") || "US",
    company_name: envText(env, "WWEX_ORIGIN_COMPANY_NAME") || "Griller's Pride",
    first_name: envText(env, "WWEX_ORIGIN_CONTACT_FIRST_NAME"),
    last_name:
      envText(env, "WWEX_ORIGIN_CONTACT_LAST_NAME", "WWEX_ORIGIN_CONTACT_NAME") ||
      "Shipping",
    phone: envText(env, "WWEX_ORIGIN_PHONE", "GRILLERS_SHIP_FROM_PHONE"),
    email: envText(env, "WWEX_ORIGIN_EMAIL"),
  }

  const missing = [
    ["WWEX_AUTH_URL", authUrl],
    ["WWEX_API_BASE_URL", apiBaseUrl],
    ["WWEX_CLIENT_ID", clientId],
    ["WWEX_CLIENT_SECRET", clientSecret],
    ["WWEX_AUDIENCE", audience],
    ["WWEX_ORIGIN_ADDRESS_1", originAddress.address_1],
    ["WWEX_ORIGIN_CITY", originAddress.city],
    ["WWEX_ORIGIN_STATE", originAddress.province],
    ["WWEX_ORIGIN_POSTAL_CODE", originAddress.postal_code],
    ["WWEX_ORIGIN_PHONE", originAddress.phone],
  ].filter(([, value]) => !value)

  if (missing.length) {
    if (clientId || clientSecret || authUrl || apiBaseUrl) {
      logger?.warn?.(
        `[wwex] Speedship client disabled; missing ${missing
          .map(([name]) => name)
          .join(", ")}`
      )
    }
    return null
  }

  return new WwexSpeedshipClient(
    {
      authUrl,
      apiBaseUrl,
      clientId,
      clientSecret,
      audience,
      originAddress: originAddress as WwexSpeedshipConfig["originAddress"],
      billToAccountNbr: envText(env, "WWEX_BILL_TO_ACCOUNT_NBR"),
      billToPostalCode: envText(env, "WWEX_BILL_TO_POSTAL_CODE"),
      billToCountryCode: envText(env, "WWEX_BILL_TO_COUNTRY_CODE") || "US",
      billToType: envText(env, "WWEX_BILL_TO_TYPE") || "SENDER",
      packageDimensions: parseDimensions(env.WWEX_PACKAGE_DIMENSIONS_JSON),
      defaultPackage: {
        length: positiveNumber(env.WWEX_DEFAULT_PACKAGE_LENGTH_IN),
        width: positiveNumber(env.WWEX_DEFAULT_PACKAGE_WIDTH_IN),
        height: positiveNumber(env.WWEX_DEFAULT_PACKAGE_HEIGHT_IN),
      },
      maxPackageWeightLb:
        positiveNumber(env.WWEX_MAX_PACKAGE_WEIGHT_LB) || 40,
      insuranceRequestFlag: envBool(env, "WWEX_INSURANCE_ENABLED", false),
      handlingCharge: env.WWEX_HANDLING_CHARGE_VALUE
        ? {
            value: env.WWEX_HANDLING_CHARGE_VALUE,
            unit:
              env.WWEX_HANDLING_CHARGE_UNIT === "PERCENT"
                ? "PERCENT"
                : "AMOUNT",
          }
        : null,
    },
    logger
  )
}

export function wwexRateInputFromFulfillmentData(
  serviceCode: string,
  data: Record<string, any>,
  estimatedPackingPlan?: ShippingPackingPlan
): WwexRateInput | null {
  const shippingAddress = data.shipping_address || data.shippingAddress || {}
  const postalCode = cleanPostalCode(shippingAddress.postal_code)
  const city = String(shippingAddress.city || "").trim()
  const state = String(
    shippingAddress.province ||
      shippingAddress.province_code ||
      shippingAddress.state ||
      ""
  ).trim()

  if (!postalCode || !city || !state) {
    return null
  }

  const metadata = data.metadata || data.cart?.metadata || data.order?.metadata || {}
  return {
    estimatedPackingPlan,
    serviceCode,
    shippingAddress,
    items: Array.isArray(data.items) ? data.items : [],
    // Checkout estimates never trust caller-supplied measured packages.
    packages: estimatedPackingPlan ? undefined : Array.isArray(data.packages) ? data.packages : undefined,
    shipmentDate:
      data.shipmentDate ||
      data.shipment_date ||
      metadata.shipmentDate ||
      metadata.shipment_date ||
      metadata.requestedShipDate ||
      metadata.requested_ship_date ||
      null,
    orderDisplayId: data.display_id || metadata.display_id || null,
    orderId: data.order_id || data.id || null,
    residentialDelivery: true,
  }
}
