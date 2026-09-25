#!/usr/bin/env node

import fs from "node:fs"
import process from "node:process"
import { hasPositiveCartTotals } from "./lib/positive-cart-totals.mjs"

const DEFAULT_BACKEND_URL =
  "https://grillers-medusa-admin-production.up.railway.app"

function readDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return {}

  const env = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue

    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }
  return env
}

function getArg(name) {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function normalizeUrl(url) {
  return (url || "").replace(/\/+$/, "")
}

async function requestJsonResult(label, url, options = {}) {
  const startedAt = Date.now()
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  })
  const bodyText = await response.text()
  const elapsed = Date.now() - startedAt

  let body = null
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    body = null
  }

  return {
    body,
    bodyText,
    elapsed,
    ok: response.ok,
    status: response.status,
  }
}

async function requestJson(label, url, options = {}) {
  const result = await requestJsonResult(label, url, options)

  if (!result.ok) {
    const preview = result.bodyText.replace(/\s+/g, " ").slice(0, 500)
    throw new Error(
      `${label} failed: HTTP ${result.status} in ${result.elapsed}ms. Body: ${preview}`
    )
  }

  return result
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function productVariantCandidates(products) {
  const candidates = []
  for (const product of products) {
    for (const variant of product.variants || []) {
      if (variant?.id) {
        candidates.push({ product, variant })
      }
    }
  }
  return candidates
}

function chooseRegion(regions, countryCode) {
  return (
    regions.find((candidate) =>
      candidate.countries?.some(
        (country) =>
          country?.iso_2?.toLowerCase() === countryCode.toLowerCase()
      )
    ) || regions[0]
  )
}

const dotEnv = readDotEnv()
const backendUrl = normalizeUrl(
  getArg("backend-url") ||
    process.env.MEDUSA_BACKEND_URL ||
    dotEnv.MEDUSA_BACKEND_URL ||
    DEFAULT_BACKEND_URL
)
const publishableKey =
  getArg("publishable-key") ||
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ||
  dotEnv.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
const adminToken =
  getArg("admin-token") ||
  process.env.MEDUSA_ADMIN_API_TOKEN ||
  dotEnv.MEDUSA_ADMIN_API_TOKEN
const countryCode =
  getArg("country-code") ||
  process.env.NEXT_PUBLIC_DEFAULT_REGION ||
  dotEnv.NEXT_PUBLIC_DEFAULT_REGION ||
  "us"

assert(backendUrl, "Missing backend URL")
assert(publishableKey, "Missing NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY")

const storeHeaders = {
  "x-publishable-api-key": publishableKey,
}

console.log(`Checking Medusa backend: ${backendUrl}`)

const health = await requestJson("health", `${backendUrl}/health`, {
  headers: { accept: "text/plain,application/json" },
})
assert(
  health.bodyText.trim() === "OK",
  `Expected /health to return OK, got ${JSON.stringify(health.bodyText)}`
)
console.log(`ok /health (${health.elapsed}ms)`)

const regions = await requestJson(
  "store regions",
  `${backendUrl}/store/regions`,
  { headers: storeHeaders }
)
assert(
  Array.isArray(regions.body?.regions) && regions.body.regions.length > 0,
  "Expected /store/regions to return at least one region"
)
console.log(`ok /store/regions (${regions.body.regions.length} regions)`)

const region = chooseRegion(regions.body.regions, countryCode)
assert(
  region?.id,
  `Expected to find a Medusa region for country code ${countryCode}`
)
console.log(`ok selected region (${region.id}, country=${countryCode})`)

const products = await requestJson(
  "store products",
  `${backendUrl}/store/products?limit=50&region_id=${encodeURIComponent(
    region.id
  )}`,
  { headers: storeHeaders }
)
assert(
  Array.isArray(products.body?.products) && products.body.products.length > 0,
  "Expected /store/products to return products"
)
assert(
  !products.body.products.some((product) => product.title === "Medusa T-Shirt"),
  "Backend appears to be serving Medusa seed data instead of the Griller's Pride catalog"
)
console.log(
  `ok /store/products (${products.body.products
    .map((product) => product.title || product.handle || product.id)
    .slice(0, 5)
    .join(", ")})`
)

const candidates = productVariantCandidates(products.body.products)
assert(
  candidates.length > 0,
  "Expected at least one product with a variant id for cart smoke testing"
)

const cartCreate = await requestJson("cart create", `${backendUrl}/store/carts`, {
  method: "POST",
  headers: {
    ...storeHeaders,
    "content-type": "application/json",
  },
  body: JSON.stringify({ region_id: region.id }),
})
const cartId = cartCreate.body?.cart?.id
assert(cartId, "Expected cart create to return cart.id")

let cartLine = null
let selection = null
let lastAddFailure = null
for (const candidate of candidates) {
  const result = await requestJsonResult(
    "cart add line item",
    `${backendUrl}/store/carts/${cartId}/line-items`,
    {
      method: "POST",
      headers: {
        ...storeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        variant_id: candidate.variant.id,
        quantity: 1,
      }),
    }
  )

  if (result.ok) {
    cartLine = result
    selection = candidate
    break
  }

  lastAddFailure = `HTTP ${result.status}: ${result.bodyText
    .replace(/\s+/g, " ")
    .slice(0, 200)}`
}

assert(
  cartLine && selection,
  `Expected at least one catalog variant to be addable to cart. Last failure: ${
    lastAddFailure || "none"
  }`
)
const cart = cartLine.body?.cart
const item = cart?.items?.[0]
assert(cart?.id === cartId, "Expected cart add response to return the same cart")
assert(item?.id, "Expected cart to contain a line item after add-to-cart")
assert(
  hasPositiveCartTotals(cart),
  "Expected cart add response to include positive live cart total and subtotal"
)
console.log(
  `ok cart create/add (${cartId}, ${
    selection.product.title || selection.product.handle || selection.product.id
  })`
)

if (adminToken) {
  const adminHeaders = { authorization: `Bearer ${adminToken}` }
  const store = await requestJson("admin store", `${backendUrl}/admin/store`, {
    headers: adminHeaders,
  })
  assert(store.body?.store, "Expected /admin/store to return a store object")
  console.log("ok /admin/store")

  const orders = await requestJson(
    "admin orders",
    `${backendUrl}/admin/orders?limit=1`,
    { headers: adminHeaders }
  )
  assert(
    Array.isArray(orders.body?.orders),
    "Expected /admin/orders to return an orders array"
  )
  console.log(`ok /admin/orders (${orders.body.orders.length} sampled)`)
} else {
  console.log("skipped admin checks; MEDUSA_ADMIN_API_TOKEN is not set")
}

console.log("Production backend smoke check passed.")
