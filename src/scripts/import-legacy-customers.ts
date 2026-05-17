import mysql from "mysql2/promise"
import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  generateEntityId,
} from "@medusajs/framework/utils"
import {
  compact,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  isTruthyLegacyFlag,
  loadFirstExistingEnvFile,
  normalizeEmail,
  normalizePhone,
  parseArgs,
  requiredEnv,
  toText,
  uniqueStrings,
} from "./lib/legacy-import-utils"

type LegacyCustomerRow = Record<string, any>

type ImportableAddress = {
  address_name: string
  company?: string | null
  first_name?: string | null
  last_name?: string | null
  address_1: string
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code: string
  phone?: string | null
  is_default_shipping?: boolean
  is_default_billing?: boolean
  metadata?: Record<string, unknown>
}

const AUTH_PROVIDER = "emailpass"
const PASSWORD_HASH_CONFIG = { logN: 15, r: 8, p: 1 }

function countryCode(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase()
  if (!text || ["us", "usa", "u.s.", "united states", "united states of america"].includes(text)) {
    return "us"
  }
  return text.slice(0, 2)
}

function fallbackNameParts(row: LegacyCustomerRow) {
  const fullName =
    toText(row.FULLNAME) ||
    toText(row.NAME) ||
    toText(row.CONTACT) ||
    toText(row.COMPANYNAME)

  if (!fullName) {
    return { firstName: null, lastName: null }
  }

  const parts = fullName.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) {
    return { firstName: parts[0] ?? null, lastName: null }
  }

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1] ?? null,
  }
}

function cleanAddressLines(
  row: LegacyCustomerRow,
  prefix: "B" | "S",
  identityLines: string[]
) {
  const rawLines = compact([
    toText(row[`${prefix}ADDR1`]),
    toText(row[`${prefix}ADDR2`]),
    toText(row[`${prefix}ADDR3`]),
    toText(row[`${prefix}ADDR4`]),
  ])

  const identitySet = new Set(
    identityLines.map((line) => line.trim().toLowerCase()).filter(Boolean)
  )

  const streetLines = rawLines.filter((line) => {
    const normalized = line.trim().toLowerCase()
    if (identitySet.has(normalized)) {
      return false
    }

    const city = String(row[`${prefix}CITY`] ?? "").trim().toLowerCase()
    const postal = String(row[`${prefix}POSTALCODE`] ?? "").trim().toLowerCase()
    if (city && normalized.includes(city) && postal && normalized.includes(postal)) {
      return false
    }

    return true
  })

  return streetLines.length ? streetLines : rawLines
}

function addressKey(address: {
  address_1?: string | null
  postal_code?: string | null
  country_code?: string | null
}) {
  return [
    address.address_1,
    address.postal_code,
    address.country_code || "us",
  ]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join("|")
}

function buildAddress(
  row: LegacyCustomerRow,
  prefix: "B" | "S",
  addressName: string,
  firstName: string | null,
  lastName: string | null,
  phone: string | null
): ImportableAddress | null {
  const company = toText(row.COMPANYNAME)
  const identityLines = compact([
    company,
    toText(row.FULLNAME),
    toText(row.NAME),
    toText(row.CONTACT),
    [firstName, lastName].filter(Boolean).join(" "),
  ])

  const lines = cleanAddressLines(row, prefix, identityLines)
  const address1 = lines[0]
  if (!address1) {
    return null
  }

  return {
    address_name: addressName,
    company,
    first_name: firstName,
    last_name: lastName,
    address_1: address1,
    address_2: lines.slice(1).join(", ") || null,
    city: toText(row[`${prefix}CITY`]),
    province: toText(row[`${prefix}STATE`]),
    postal_code: toText(row[`${prefix}POSTALCODE`]),
    country_code: countryCode(row[`${prefix}COUNTRY`]),
    phone,
    metadata: {
      legacy_source: "legacy_site_customers",
      legacy_address_type: prefix === "S" ? "shipping" : "billing",
    },
  }
}

function buildAddresses(
  row: LegacyCustomerRow,
  firstName: string | null,
  lastName: string | null,
  phone: string | null
) {
  const addresses = compact([
    buildAddress(row, "S", "Legacy shipping", firstName, lastName, phone),
    buildAddress(row, "B", "Legacy billing", firstName, lastName, phone),
  ])

  const seen = new Set<string>()
  return addresses.filter((address) => {
    const key = addressKey(address)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

async function hashPassword(password: string) {
  const scrypt = await import("scrypt-kdf")
  const kdf = ((scrypt as any).default ?? scrypt) as any
  const passwordHash = await kdf.kdf(password, PASSWORD_HASH_CONFIG)
  return Buffer.from(passwordHash as any).toString("base64")
}

async function findCustomerByEmail(db: any, emailLower: string) {
  return db("customer")
    .select("*")
    .whereNull("deleted_at")
    .whereRaw("lower(email) = ?", [emailLower])
    .orderBy("has_account", "desc")
    .orderBy("created_at", "asc")
    .first()
}

async function ensureCustomer({
  db,
  customerModule,
  legacy,
  apply,
}: {
  db: any
  customerModule: any
  legacy: ReturnType<typeof normalizeLegacyCustomer>
  apply: boolean
}) {
  const metadata = {
    legacy_source: "legacy_site_customers",
    legacy_customer_id: legacy.legacyCustomerId,
    qbd_customer_list_id: legacy.qbdCustomerListId,
    legacy_username: legacy.username,
    legacy_can_order_online: legacy.canOrderOnline,
    legacy_is_active: legacy.isActive,
  }

  const existing = await findCustomerByEmail(db, legacy.emailLower)
  if (!apply) {
    return existing
      ? { id: existing.id, metadata: existing.metadata, has_account: existing.has_account }
      : null
  }

  if (existing) {
    const update: Record<string, unknown> = {
      has_account: true,
      updated_at: new Date(),
    }

    if (!toText(existing.first_name) && legacy.firstName) {
      update.first_name = legacy.firstName
    }
    if (!toText(existing.last_name) && legacy.lastName) {
      update.last_name = legacy.lastName
    }
    if (!toText(existing.phone) && legacy.phone) {
      update.phone = legacy.phone
    }
    if (!toText(existing.company_name) && legacy.companyName) {
      update.company_name = legacy.companyName
    }

    await db("customer")
      .where({ id: existing.id })
      .update({
        ...update,
        metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify(metadata),
        ]),
      })

    return {
      ...existing,
      ...update,
      metadata: { ...(existing.metadata ?? {}), ...metadata },
    }
  }

  return customerModule.createCustomers({
    email: legacy.emailLower,
    first_name: legacy.firstName,
    last_name: legacy.lastName,
    phone: legacy.phone,
    company_name: legacy.companyName,
    has_account: true,
    metadata,
  })
}

async function listProviderIdentities(
  db: any,
  identifiers: string[]
): Promise<any[]> {
  if (!identifiers.length) {
    return []
  }

  return db("provider_identity")
    .select(["id", "entity_id", "auth_identity_id", "provider_metadata"])
    .where("provider", AUTH_PROVIDER)
    .whereIn("entity_id", identifiers)
    .whereNull("deleted_at")
}

async function getProviderPasswordHash(db: any, authIdentityId: string) {
  const row = await db("provider_identity")
    .select("provider_metadata")
    .where("provider", AUTH_PROVIDER)
    .where("auth_identity_id", authIdentityId)
    .whereNull("deleted_at")
    .whereRaw("provider_metadata ? 'password'")
    .first()

  return typeof row?.provider_metadata?.password === "string"
    ? row.provider_metadata.password
    : null
}

async function ensureAuthIdentity({
  db,
  legacy,
  customerId,
  apply,
  updateExistingPasswords,
}: {
  db: any
  legacy: ReturnType<typeof normalizeLegacyCustomer>
  customerId: string | null
  apply: boolean
  updateExistingPasswords: boolean
}) {
  if (!legacy.password || !customerId) {
    return { status: legacy.password ? "no_customer" : "no_password", authIdentityId: null }
  }

  const canonicalIdentifiers = uniqueStrings([
    legacy.emailLower,
    legacy.emailOriginal,
  ])
  const aliasIdentifiers = uniqueStrings([
    legacy.username,
    legacy.username?.toLowerCase(),
  ]).filter((identifier) => !canonicalIdentifiers.includes(identifier))

  const canonicalRows = await listProviderIdentities(db, canonicalIdentifiers)
  const authIds = uniqueStrings(canonicalRows.map((row: any) => row.auth_identity_id))
  if (authIds.length > 1) {
    return { status: "conflict_multiple_email_identities", authIdentityId: null }
  }

  const now = new Date()
  const legacyPasswordHash = apply ? await hashPassword(legacy.password) : null
  let authIdentityId = authIds[0] ?? null
  let existingPasswordHash =
    authIdentityId && !updateExistingPasswords
      ? await getProviderPasswordHash(db, authIdentityId)
      : null
  const providerPasswordHash = existingPasswordHash || legacyPasswordHash

  if (!apply) {
    return {
      status: authIdentityId ? "would_update_auth" : "would_create_auth",
      authIdentityId,
    }
  }

  if (!providerPasswordHash) {
    return { status: "no_password_hash", authIdentityId: null }
  }

  if (!authIdentityId) {
    authIdentityId = generateEntityId(undefined, "authid")
    await db("auth_identity").insert({
      id: authIdentityId,
      app_metadata: { customer_id: customerId },
      created_at: now,
      updated_at: now,
    })
  } else {
    await db("auth_identity")
      .where({ id: authIdentityId })
      .update({
        app_metadata: db.raw("coalesce(app_metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({ customer_id: customerId }),
        ]),
        updated_at: now,
      })
  }

  const allIdentifiers = uniqueStrings([...canonicalIdentifiers, ...aliasIdentifiers])
  const existingRows = await listProviderIdentities(db, allIdentifiers)
  const existingByIdentifier = new Map(
    existingRows.map((row: any) => [row.entity_id, row])
  )
  let aliasesSkipped = 0

  for (const identifier of allIdentifiers) {
    const existing = existingByIdentifier.get(identifier)
    if (existing && existing.auth_identity_id !== authIdentityId) {
      aliasesSkipped += 1
      continue
    }

    if (existing) {
      const providerMetadata = updateExistingPasswords
        ? db.raw("coalesce(provider_metadata, '{}'::jsonb) || ?::jsonb", [
            JSON.stringify({ password: providerPasswordHash }),
          ])
        : existing.provider_metadata

      await db("provider_identity").where({ id: existing.id }).update({
        provider_metadata: providerMetadata,
        user_metadata: db.raw("coalesce(user_metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({
            legacy_import: true,
            legacy_customer_id: legacy.legacyCustomerId,
          }),
        ]),
        updated_at: now,
      })
      continue
    }

    await db("provider_identity").insert({
      id: generateEntityId(),
      entity_id: identifier,
      provider: AUTH_PROVIDER,
      auth_identity_id: authIdentityId,
      provider_metadata: { password: providerPasswordHash },
      user_metadata: {
        legacy_import: true,
        legacy_customer_id: legacy.legacyCustomerId,
      },
      created_at: now,
      updated_at: now,
    })
  }

  return {
    status: aliasesSkipped ? "imported_with_alias_conflicts" : "imported",
    authIdentityId,
  }
}

async function ensureAddresses({
  customerModule,
  customerId,
  addresses,
  apply,
}: {
  customerModule: any
  customerId: string | null
  addresses: ImportableAddress[]
  apply: boolean
}) {
  if (!customerId) {
    return { status: "no_customer", created: 0 }
  }

  const existing = await customerModule.listCustomerAddresses(
    { customer_id: customerId },
    { take: 200 }
  )
  const existingKeys = new Set(existing.map(addressKey))
  const hasDefaultShipping = existing.some((a: any) => a.is_default_shipping)
  const hasDefaultBilling = existing.some((a: any) => a.is_default_billing)
  const missing = addresses.filter((address) => !existingKeys.has(addressKey(address)))

  if (!missing.length) {
    return { status: "up_to_date", created: 0 }
  }

  let defaultShippingAssigned = hasDefaultShipping
  let defaultBillingAssigned = hasDefaultBilling
  const payload = missing.map((address) => {
    const isShipping = address.metadata?.legacy_address_type === "shipping"
    const create = {
      ...address,
      customer_id: customerId,
      is_default_shipping: !defaultShippingAssigned && isShipping,
      is_default_billing: !defaultBillingAssigned && (!isShipping || missing.length === 1),
    }
    defaultShippingAssigned ||= create.is_default_shipping
    defaultBillingAssigned ||= create.is_default_billing
    return create
  })

  if (!apply) {
    return { status: "would_create", created: payload.length }
  }

  await customerModule.createCustomerAddresses(payload)
  return { status: "imported", created: payload.length }
}

async function upsertCustomerMap({
  db,
  legacy,
  customerId,
  authIdentityId,
  authStatus,
  addressStatus,
  apply,
}: {
  db: any
  legacy: ReturnType<typeof normalizeLegacyCustomer>
  customerId: string | null
  authIdentityId: string | null
  authStatus: string
  addressStatus: string
  apply: boolean
}) {
  if (!apply) {
    return
  }

  const now = new Date()
  const row = {
    qbd_customer_list_id: legacy.qbdCustomerListId,
    medusa_customer_id: customerId,
    medusa_auth_identity_id: authIdentityId,
    email_lower: legacy.emailLower,
    legacy_username: legacy.username,
    first_name: legacy.firstName,
    last_name: legacy.lastName,
    phone: legacy.phone,
    auth_import_status: authStatus,
    address_import_status: addressStatus,
    last_imported_at: now,
    metadata: {
      legacy_source: "legacy_site_customers",
      can_order_online: legacy.canOrderOnline,
      is_active: legacy.isActive,
    },
    updated_at: now,
  }

  const existing = await db("legacy_customer_map")
    .select("id")
    .where("legacy_customer_id", legacy.legacyCustomerId)
    .whereNull("deleted_at")
    .first()

  if (existing) {
    await db("legacy_customer_map").where({ id: existing.id }).update(row)
    return
  }

  await db("legacy_customer_map").insert({
    id: generateEntityId(undefined, "lgcmap"),
    legacy_customer_id: legacy.legacyCustomerId,
    ...row,
    created_at: now,
  })
}

async function backfillLegacyOrderCustomerLink({
  db,
  legacy,
  customerId,
  apply,
}: {
  db: any
  legacy: ReturnType<typeof normalizeLegacyCustomer>
  customerId: string | null
  apply: boolean
}) {
  if (!apply || !customerId) {
    return
  }

  const now = new Date()
  await db("legacy_order")
    .whereNull("deleted_at")
    .andWhere((builder: any) => {
      if (legacy.qbdCustomerListId) {
        builder.orWhere("qbd_customer_list_id", legacy.qbdCustomerListId)
      }
      builder.orWhere("legacy_customer_id", legacy.legacyCustomerId)
      if (legacy.emailLower) {
        builder.orWhere("email_lower", legacy.emailLower)
      }
    })
    .update({
      medusa_customer_id: customerId,
      legacy_customer_id: legacy.legacyCustomerId,
      email_lower: legacy.emailLower,
      updated_at: now,
      metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ customer_link_backfilled_at: now.toISOString() }),
      ]),
    })
}

function normalizeLegacyCustomer(row: LegacyCustomerRow) {
  const fallback = fallbackNameParts(row)
  const emailOriginal = toText(row.EMAIL)
  const emailLower = normalizeEmail(emailOriginal)
  const phone = normalizePhone(row.MOBILE) || normalizePhone(row.PHONE)
  const firstName = toText(row.FIRSTNAME) || fallback.firstName
  const lastName = toText(row.LASTNAME) || fallback.lastName

  return {
    legacyCustomerId: String(row.ID),
    qbdCustomerListId: toText(row.LISTID),
    emailOriginal,
    emailLower: emailLower || "",
    username: toText(row.USERNAME),
    password: toText(row.PASSWORD),
    firstName,
    lastName,
    companyName: toText(row.COMPANYNAME),
    phone,
    isActive: isTruthyLegacyFlag(row.ISACTIVE),
    canOrderOnline: isTruthyLegacyFlag(row.CANORDERONLINE),
    addresses: buildAddresses(row, firstName, lastName, phone),
  }
}

function buildLegacyCustomerQuery(limit: number, offset: number) {
  const base = `
    SELECT
      ID, LISTID, NAME, FULLNAME, COMPANYNAME, FIRSTNAME, LASTNAME,
      BADDR1, BADDR2, BADDR3, BADDR4, BCITY, BSTATE, BPOSTALCODE, BCOUNTRY,
      SADDR1, SADDR2, SADDR3, SADDR4, SCITY, SSTATE, SPOSTALCODE, SCOUNTRY,
      PHONE, MOBILE, EMAIL, CONTACT, PASSWORD, USERNAME, ISACTIVE, CANORDERONLINE
    FROM CUSTOMERS
    WHERE NULLIF(TRIM(EMAIL), '') IS NOT NULL
    ORDER BY ID
  `

  if (limit > 0) {
    return `${base} LIMIT ${limit} OFFSET ${Math.max(offset, 0)}`
  }

  return base
}

export default async function importLegacyCustomers({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const customerModule = container.resolve(Modules.CUSTOMER) as any
  const args = parseArgs()

  const apply = getBooleanArg(args, ["apply"], false)
  const updateExistingPasswords = getBooleanArg(
    args,
    ["update-existing-passwords"],
    false
  )
  const limit = getNumberArg(args, ["limit"], 0)
  const offset = getNumberArg(args, ["offset"], 0)
  const envFile = getStringArg(args, ["env-file", "legacy-env-file"])

  const loadedEnv = loadFirstExistingEnvFile([
    envFile,
    process.env.LEGACY_ENV_FILE,
    process.env.ENV_FILE,
    ".env.legacy",
    "../grillerspride/.env.legacy",
  ])

  if (!loadedEnv) {
    logger.warn(
      "[legacy-customers] no env file loaded; expecting legacy DB env vars in process environment"
    )
  }

  const connection = await mysql.createConnection({
    host: requiredEnv("LEGACY_DB_HOST"),
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    database: requiredEnv("LEGACY_DB_NAME"),
    user: requiredEnv("LEGACY_DB_USER"),
    password: requiredEnv("LEGACY_DB_PASSWORD"),
    connectTimeout: 20000,
    ssl: process.env.LEGACY_DB_SSL === "1" ? {} : undefined,
  })

  const stats = {
    seen: 0,
    skippedInvalidEmail: 0,
    customersCreated: 0,
    customersMatched: 0,
    authImported: 0,
    authSkipped: 0,
    addressRowsCreated: 0,
    failed: 0,
  }

  try {
    const [rows] = await connection.query(buildLegacyCustomerQuery(limit, offset))

    for (const row of rows as LegacyCustomerRow[]) {
      stats.seen += 1
      const legacy = normalizeLegacyCustomer(row)
      if (!legacy.emailLower) {
        stats.skippedInvalidEmail += 1
        continue
      }

      try {
        const existing = await findCustomerByEmail(db, legacy.emailLower)
        const customer = await ensureCustomer({
          db,
          customerModule,
          legacy,
          apply,
        })
        const customerId = customer?.id ?? null
        if (existing) {
          stats.customersMatched += 1
        } else if (apply && customerId) {
          stats.customersCreated += 1
        }

        const auth = await ensureAuthIdentity({
          db,
          legacy,
          customerId,
          apply,
          updateExistingPasswords,
        })
        if (auth.status === "imported" || auth.status === "imported_with_alias_conflicts") {
          stats.authImported += 1
        } else {
          stats.authSkipped += 1
        }

        const addressResult = await ensureAddresses({
          customerModule,
          customerId,
          addresses: legacy.addresses,
          apply,
        })
        stats.addressRowsCreated += addressResult.created

        await upsertCustomerMap({
          db,
          legacy,
          customerId,
          authIdentityId: auth.authIdentityId,
          authStatus: auth.status,
          addressStatus: addressResult.status,
          apply,
        })

        await backfillLegacyOrderCustomerLink({
          db,
          legacy,
          customerId,
          apply,
        })
      } catch (error) {
        stats.failed += 1
        logger.error(
          `[legacy-customers] failed legacy_customer_id=${legacy.legacyCustomerId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } finally {
    await connection.end()
  }

  logger.info(
    `[legacy-customers] ${apply ? "applied" : "dry-run"} ${JSON.stringify(stats)}`
  )
}
