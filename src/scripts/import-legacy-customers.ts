import mysql from "mysql2/promise"
import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  generateEntityId,
} from "@medusajs/framework/utils"
import {
  compact,
  envVarsAreSet,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  isTruthyLegacyFlag,
  loadEnvFilesUntil,
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

function legacyDbEnvIsAvailable() {
  return envVarsAreSet([
    "LEGACY_DB_HOST",
    "LEGACY_DB_NAME",
    "LEGACY_DB_USER",
    "LEGACY_DB_PASSWORD",
  ])
}

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
    .whereRaw("provider_metadata->>'password' is not null")
    .first()

  return typeof row?.provider_metadata?.password === "string"
    ? row.provider_metadata.password
    : null
}

async function ensureResetReadyAuthIdentity({
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
  if (!customerId) {
    return { status: "no_customer", authIdentityId: null }
  }

  const canonicalIdentifiers = uniqueStrings([
    legacy.emailLower,
    legacy.emailOriginal,
  ])
  const canonicalRows = await listProviderIdentities(db, canonicalIdentifiers)
  const authIds = uniqueStrings(canonicalRows.map((row: any) => row.auth_identity_id))
  if (authIds.length > 1) {
    return { status: "conflict_multiple_email_identities", authIdentityId: null }
  }

  const now = new Date()
  let authIdentityId = authIds[0] ?? null

  if (!apply) {
    return {
      status: authIdentityId
        ? "would_update_reset_ready_no_password"
        : "would_create_reset_ready_no_password",
      authIdentityId,
    }
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

  const existingRows = await listProviderIdentities(db, canonicalIdentifiers)
  const existingByIdentifier = new Map(
    existingRows.map((row: any) => [row.entity_id, row])
  )
  let aliasesSkipped = 0

  for (const identifier of canonicalIdentifiers) {
    const existing = existingByIdentifier.get(identifier)
    if (existing && existing.auth_identity_id !== authIdentityId) {
      aliasesSkipped += 1
      continue
    }

    if (existing) {
      await db("provider_identity").where({ id: existing.id }).update({
        user_metadata: db.raw("coalesce(user_metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({
            legacy_import: true,
            legacy_customer_id: legacy.legacyCustomerId,
            legacy_password_reset_ready: true,
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
      provider_metadata: {},
      user_metadata: {
        legacy_import: true,
        legacy_customer_id: legacy.legacyCustomerId,
        legacy_password_reset_ready: true,
      },
      created_at: now,
      updated_at: now,
    })
  }

  return {
    status: aliasesSkipped
      ? "reset_ready_no_password_with_email_conflicts"
      : "reset_ready_no_password",
    authIdentityId,
  }
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
  if (!customerId) {
    return { status: "no_customer", authIdentityId: null }
  }

  if (!legacy.password) {
    return ensureResetReadyAuthIdentity({
      db,
      legacy,
      customerId,
      apply,
    })
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

function buildLegacyCustomerQuery(
  limit: number,
  offset: number,
  options: { onlyNoPassword?: boolean; ids?: string[] } = {}
) {
  const base = `
    SELECT
      ID, LISTID, NAME, FULLNAME, COMPANYNAME, FIRSTNAME, LASTNAME,
      BADDR1, BADDR2, BADDR3, BADDR4, BCITY, BSTATE, BPOSTALCODE, BCOUNTRY,
      SADDR1, SADDR2, SADDR3, SADDR4, SCITY, SSTATE, SPOSTALCODE, SCOUNTRY,
      PHONE, MOBILE, EMAIL, CONTACT, PASSWORD, USERNAME, ISACTIVE, CANORDERONLINE
    FROM CUSTOMERS
    WHERE NULLIF(TRIM(EMAIL), '') IS NOT NULL
      ${options.onlyNoPassword ? "AND NULLIF(TRIM(PASSWORD), '') IS NULL" : ""}
      ${options.ids?.length ? "AND ID IN (?)" : ""}
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
  const onlyNoPassword = getBooleanArg(args, ["only-no-password"], false)
  const limit = getNumberArg(args, ["limit"], 0)
  const offset = getNumberArg(args, ["offset"], 0)
  const requestedBatchSize = getNumberArg(args, ["batch-size"], 500)
  const batchSize = Math.max(requestedBatchSize || 500, 1)
  const envFile = getStringArg(args, ["env-file", "legacy-env-file"])
  const idsFile = getStringArg(args, ["ids-file"])
  const manifestOutput = getStringArg(args, ["manifest-output"])
  const b0Manifest = getStringArg(args, ["b0-manifest"])
  const ruleManifest = getStringArg(args, ["rule-manifest"])
  const expectedIdsSha256 = getStringArg(args, ["expected-ids-sha256"])
  const expectedCount = getNumberArg(args, ["expected-count"], 0)

  if (idsFile && (apply || updateExistingPasswords || onlyNoPassword || limit || offset)) {
    throw new Error("--ids-file is dry-run only and cannot be combined with apply, password updates, or pagination")
  }
  if (idsFile && (!manifestOutput || !b0Manifest || !ruleManifest || !expectedIdsSha256 || !expectedCount)) {
    throw new Error("--ids-file requires manifest output, B0 and rule manifests, expected ID hash, and expected count")
  }
  if (!idsFile && (manifestOutput || b0Manifest || ruleManifest || expectedIdsSha256 || expectedCount)) {
    throw new Error("B0 receipt flags require --ids-file")
  }

  const selectedIds = idsFile
    ? fs.readFileSync(idsFile, "utf8").trim().split(/\r?\n/)
    : null
  const sha256File = (file: string) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  let b0Evidence: {
    sourceSnapshotUtc: string
    targetSnapshotUtc: string
    sourceSha256: string
    reviewSha256: string
  } | null = null
  if (selectedIds) {
    if (selectedIds.length !== expectedCount ||
        new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some((id) => !/^\d+$/.test(id))) {
      throw new Error("protected ID list count, uniqueness, or format mismatch")
    }
    const actualHash = sha256File(idsFile!)
    if (actualHash !== expectedIdsSha256) {
      throw new Error("protected ID list SHA-256 mismatch")
    }

    const b0 = JSON.parse(fs.readFileSync(b0Manifest!, "utf8"))
    const rule = JSON.parse(fs.readFileSync(ruleManifest!, "utf8"))
    const b0Sha256 = sha256File(b0Manifest!)
    if (rule.b0_manifest_sha256 !== b0Sha256) {
      throw new Error("rule manifest does not match the frozen B0 manifest")
    }
    const sourceFile = path.join(path.dirname(b0Manifest!), b0.source.private_file)
    const reviewFile = path.join(path.dirname(ruleManifest!), rule.private_review_file)
    if (sha256File(sourceFile) !== b0.source.sha256 ||
        sha256File(reviewFile) !== rule.private_review_sha256) {
      throw new Error("frozen B0 source or R1 review hash mismatch")
    }
    const sourceIds = new Set(
      fs.readFileSync(sourceFile, "utf8").trim().split(/\r?\n/)
        .map((line) => String(JSON.parse(line).source_id))
    )
    const reviewedR1Ids = new Set(
      fs.readFileSync(reviewFile, "utf8").trim().split(/\r?\n/)
        .slice(1)
        .filter((line) => line.split(",")[2] === "R1_guarded_new_customer")
        .map((line) => line.split(",")[1])
    )
    if (reviewedR1Ids.size !== selectedIds.length ||
        selectedIds.some((id) => !sourceIds.has(id) || !reviewedR1Ids.has(id))) {
      throw new Error("selected IDs differ from the exact reviewed B0 R1 set")
    }
    b0Evidence = {
      sourceSnapshotUtc: b0.source.snapshot_utc,
      targetSnapshotUtc: b0.target.snapshot_utc,
      sourceSha256: b0.source.sha256,
      reviewSha256: rule.private_review_sha256,
    }
  }

  const loadedEnv = loadEnvFilesUntil([
    envFile,
    process.env.LEGACY_ENV_FILE,
    process.env.ENV_FILE,
    ".env.legacy",
    ".env.local",
    ".env",
    "../grillerspride/.env.legacy",
    "../grillerspride/.env",
  ], legacyDbEnvIsAvailable)

  if (!loadedEnv.length) {
    logger.warn(
      "[legacy-customers] no env file loaded; expecting legacy DB env vars in process environment"
    )
  }

  const legacyConnectionConfig = {
    host: requiredEnv("LEGACY_DB_HOST"),
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    database: requiredEnv("LEGACY_DB_NAME"),
    user: requiredEnv("LEGACY_DB_USER"),
    password: requiredEnv("LEGACY_DB_PASSWORD"),
    connectTimeout: 20000,
    ssl: process.env.LEGACY_DB_SSL === "1" ? {} : undefined,
  }

  async function fetchLegacyCustomerBatch(pageLimit: number, currentOffset: number) {
    const connection = await mysql.createConnection(legacyConnectionConfig)
    try {
      const [rows] = await connection.query(
        buildLegacyCustomerQuery(pageLimit, currentOffset, { onlyNoPassword, ids: selectedIds ?? undefined }),
        selectedIds ? [selectedIds] : []
      )
      return rows as LegacyCustomerRow[]
    } finally {
      await connection.end().catch(() => undefined)
    }
  }

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
  const receiptRows: Array<Record<string, unknown>> = []

  if (selectedIds) {
    const readOnly = await db.raw("select current_setting('transaction_read_only') as read_only")
    if (readOnly?.rows?.[0]?.read_only !== "on") {
      throw new Error("B0 importer dry run requires a read-only PostgreSQL session")
    }
  }

  async function processLegacyCustomerRow(row: LegacyCustomerRow) {
    stats.seen += 1
    const legacy = normalizeLegacyCustomer(row)
    if (!legacy.emailLower) {
      stats.skippedInvalidEmail += 1
      if (selectedIds) {
        receiptRows.push({ legacy_customer_id: legacy.legacyCustomerId, outcome: "invalid_email" })
      }
      return
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
      if (
        auth.status === "imported" ||
        auth.status === "imported_with_alias_conflicts" ||
        auth.status === "reset_ready_no_password" ||
        auth.status === "reset_ready_no_password_with_email_conflicts"
      ) {
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
      if (selectedIds) {
        receiptRows.push({
          legacy_customer_id: legacy.legacyCustomerId,
          outcome: "dry_run",
          customer_action: existing ? "would_match_existing" : "would_create",
          existing_customer_id: customerId,
          auth_status: auth.status,
          address_status: addressResult.status,
        })
      }
    } catch (error) {
      stats.failed += 1
      if (selectedIds) {
        receiptRows.push({ legacy_customer_id: legacy.legacyCustomerId, outcome: "failed" })
      }
      logger.error(
        `[legacy-customers] failed legacy_customer_id=${legacy.legacyCustomerId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  let currentOffset = offset
  let remaining = selectedIds ? selectedIds.length : limit > 0 ? limit : Number.POSITIVE_INFINITY

  while (remaining > 0) {
    const pageLimit = selectedIds ? 0 : Math.min(batchSize, remaining)
    const batch = await fetchLegacyCustomerBatch(pageLimit, currentOffset)
    if (!batch.length) {
      break
    }

    for (const row of batch) {
      await processLegacyCustomerRow(row)
    }

    currentOffset += batch.length
    remaining -= batch.length

    logger.info(
      `[legacy-customers] progress ${JSON.stringify({
        seen: stats.seen,
        failed: stats.failed,
        nextOffset: currentOffset,
      })}`
    )

    if (selectedIds || batch.length < pageLimit) {
      break
    }
  }

  if (selectedIds) {
    const seen = new Set(receiptRows.map((row) => String(row.legacy_customer_id)))
    if (seen.size !== selectedIds.length || selectedIds.some((id) => !seen.has(id))) {
      throw new Error("selected ID coverage mismatch; refusing to issue a complete B0 dry-run receipt")
    }
    const manifest = {
      kind: "gp337_existing_importer_r1_dry_run",
      created_at_utc: new Date().toISOString(),
      writes: 0,
      target_read_only: true,
      selected_ids_sha256: expectedIdsSha256,
      b0_manifest_sha256: sha256File(b0Manifest!),
      rule_manifest_sha256: sha256File(ruleManifest!),
      b0_source_sha256: b0Evidence!.sourceSha256,
      b0_r1_review_sha256: b0Evidence!.reviewSha256,
      b0_source_snapshot_utc: b0Evidence!.sourceSnapshotUtc,
      b0_target_snapshot_utc: b0Evidence!.targetSnapshotUtc,
      expected_ids: selectedIds.length,
      stats,
      rows: receiptRows.sort((a, b) => Number(a.legacy_customer_id) - Number(b.legacy_customer_id)),
    }
    fs.writeFileSync(manifestOutput!, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  }

  logger.info(
    `[legacy-customers] ${apply ? "applied" : "dry-run"} ${JSON.stringify(stats)}`
  )
}
