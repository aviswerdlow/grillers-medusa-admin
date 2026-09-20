import { randomUUID } from "node:crypto"
import path from "node:path"
import { MikroORM, EntitySchema } from "@mikro-orm/postgresql"
import { FeatureFlag } from "@medusajs/framework/utils"
import {
  internalCatalogProductIds,
  assertPublicCatalogVariants,
  isInternalCatalogProduct,
} from "../../src/lib/public-catalog"
import {
  filterPublicCatalog,
  guardNewCartItems,
  guardAddedCartItem,
  guardUpdatedCartItem,
  guardCompletedCart,
  guardCartPaymentSession,
  guardInventoryVariants,
  guardInventoryResolution,
} from "../../src/api/middlewares/public-catalog"

const knex = require("knex")
const schema = `gp_catalog_${randomUUID().replace(/-/g, "")}`
let db: any, admin: any
let orm: any
const fixtureEntity = new EntitySchema({
  name: "CatalogFixture",
  tableName: "product",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
    metadata: { type: "json", nullable: true },
    deleted_at: { type: "Date", nullable: true },
  },
})
const graph = jest.fn()
const scope = {
  resolve: (key: string) =>
    key === "query" ? { graph } : key === "logger" ? { warn: jest.fn() } : db,
}
const cases = [
  {
    id: "retail",
    sku: "01-1",
    metadata: {},
    productMetadata: {},
    internal: false,
  },
  {
    id: "raw",
    sku: "RM-one",
    metadata: {},
    productMetadata: {},
    internal: true,
  },
  {
    id: "space",
    sku: "\t rm-two \n",
    metadata: {},
    productMetadata: {},
    internal: true,
  },
  {
    id: "renamed",
    sku: "01-new-name",
    metadata: {
      availability_lifecycle: "internal_only",
      qbd_list_id: "stable",
    },
    productMetadata: {},
    internal: true,
  },
  {
    id: "parent",
    sku: "retail-looking",
    metadata: { availability_lifecycle: "active" },
    productMetadata: { AvailabilityLifecycle: " INTERNAL_ONLY " },
    internal: true,
  },
  {
    id: "seasonal",
    sku: "Y-retail",
    metadata: { availability_lifecycle: "seasonal_inactive" },
    productMetadata: {},
    internal: false,
  },
  {
    id: "oos",
    sku: "retail-zero",
    metadata: { availability_lifecycle: "active" },
    productMetadata: {},
    internal: false,
  },
]

beforeAll(async () => {
  const connection =
    process.env.CATALOG_TEST_DATABASE_URL ||
    (process.env.CATALOG_TEST_PG_SOCKET && {
      host: process.env.CATALOG_TEST_PG_SOCKET,
      port: 55431,
      user: "gp_launch_test",
      database: "gp_launch",
    })
  if (!connection)
    throw new Error(
      "Supply an isolated CATALOG_TEST_DATABASE_URL or CATALOG_TEST_PG_SOCKET; never DATABASE_URL."
    )
  admin = knex({ client: "pg", connection })
  await admin.raw(`create schema ${schema}`)
  db = knex({ client: "pg", connection, searchPath: [schema] })
  await db.raw(
    "create table product (id text primary key, status text, metadata jsonb, deleted_at timestamptz)"
  )
  await db.raw(
    "create table product_variant (id text primary key, product_id text, sku text, metadata jsonb, deleted_at timestamptz)"
  )
  for (const item of cases) {
    await db("product").insert({
      id: item.id,
      status: "published",
      metadata: JSON.stringify(item.productMetadata),
    })
    await db("product_variant").insert({
      id: `v_${item.id}`,
      product_id: item.id,
      sku: item.sku,
      metadata: JSON.stringify(item.metadata),
    })
  }
  await db("product_variant").insert({
    id: "v_mixed_retail",
    product_id: "raw",
    sku: "retail",
    metadata: "{}",
  })
  orm = await MikroORM.init({
    entities: [fixtureEntity],
    schema,
    ...(typeof connection === "string"
      ? { clientUrl: connection }
      : {
          host: connection.host,
          port: connection.port,
          user: connection.user,
          dbName: connection.database,
        }),
  })
})
afterAll(async () => {
  if (orm) await orm.close(true)
  if (db) await db.destroy()
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`)
    await admin.destroy()
  }
})
beforeEach(() => graph.mockReset())

it("keeps SQL eligibility consistent with normalized lifecycle/SKU classification", async () => {
  const ids = await internalCatalogProductIds(db)
  for (const item of cases) {
    const pure = isInternalCatalogProduct({
      metadata: item.productMetadata,
      variants: [{ sku: item.sku, metadata: item.metadata }],
    })
    expect(pure).toBe(item.internal)
    expect(ids.includes(item.id)).toBe(item.internal)
  }
  expect(
    await db("product_variant").where({ id: "v_renamed" }).first()
  ).toMatchObject({ metadata: { qbd_list_id: "stable" } })
})
it.each(cases.filter((c) => c.internal).map((c) => [c.id]))(
  "rejects canonical internal variant %s",
  async (id) => {
    await expect(
      assertPublicCatalogVariants(scope, [`v_${id}`])
    ).rejects.toMatchObject({ status: 400 })
  }
)
it("rejects mixed products, missing variants, and incomplete bulk results", async () => {
  for (const ids of [
    ["v_mixed_retail"],
    ["unknown"],
    ["v_retail", "unknown"],
    [undefined],
  ]) {
    await expect(assertPublicCatalogVariants(scope, ids)).rejects.toMatchObject(
      { status: 400 }
    )
  }
})
it("allows retail classification with zero stock; inventory remains a separate check", async () => {
  await expect(
    assertPublicCatalogVariants(scope, ["v_retail", "v_oos", "v_retail"])
  ).resolves.toBeUndefined()
})
async function run(
  guard: any,
  body: any = {},
  params: any = {},
  customScope = scope,
  filters: any = {}
) {
  const req: any = {
    body,
    params,
    scope: customScope,
    filterableFields: filters,
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  await guard(req, res, next)
  return { req, res, next }
}
it("adds a non-bypassable exclusion while retaining id, channel and OR filters before pagination", async () => {
  const filters = {
    id: ["raw", "retail"],
    sales_channel_id: ["channel"],
    $or: [{ handle: "raw" }],
    $and: [{ status: "published" }],
  }
  const r = await run(filterPublicCatalog, {}, {}, scope, filters)
  expect(r.next).toHaveBeenCalledTimes(1)
  expect(r.req.filterableFields).toMatchObject({
    id: ["raw", "retail"],
    sales_channel_id: ["channel"],
    $or: [{ handle: "raw" }],
  })
  expect(r.req.filterableFields.$and).toEqual([
    { status: "published" },
    { id: { $nin: expect.arrayContaining(["raw", "renamed", "parent"]) } },
  ])
})
it("the installed native product handler preserves the exclusion through Medusa query building and ORM pagination/count", async () => {
  const nativeGET = require(path.join(
    path.dirname(require.resolve("@medusajs/medusa")),
    "api/store/products/route"
  )).GET
  const { buildQuery } = require(path.join(
    path.dirname(require.resolve("@medusajs/utils")),
    "modules-sdk/build-query"
  ))
  const flag = jest
    .spyOn(FeatureFlag, "isFeatureEnabled")
    .mockReturnValue(false)
  try {
    const remoteQuery = async (queryObject: any) => {
      const { filters, take, skip } = queryObject.__value.product.__args
      const query = buildQuery(filters, {
        take,
        skip,
        select: ["id"],
        order: { id: "ASC" },
      })
      const [rows, count] = await orm.em
        .fork()
        .findAndCount("CatalogFixture", query.where, query.options)
      return { rows, metadata: { count, take, skip } }
    }
    const nativeScope = {
      resolve: (key: string) =>
        key === "remoteQuery" ? remoteQuery : scope.resolve(key),
    }
    const result = await run(filterPublicCatalog, {}, {}, nativeScope, {
      status: "published",
      id: cases.map((c) => c.id),
    })
    result.req.queryConfig = {
      fields: ["id"],
      pagination: { take: 1, skip: 1 },
    }
    await nativeGET(result.req, result.res)
    expect(result.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 3,
        products: [expect.objectContaining({ id: "retail" })],
        limit: 1,
        offset: 1,
      })
    )

    const bypass = await run(filterPublicCatalog, {}, {}, nativeScope, {
      $or: [{ id: "raw" }, { id: "parent" }],
    })
    bypass.req.queryConfig = {
      fields: ["id"],
      pagination: { take: 10, skip: 0 },
    }
    await nativeGET(bypass.req, bypass.res)
    expect(bypass.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ count: 0, products: [] })
    )
  } finally {
    flag.mockRestore()
  }
})
it("rejects internal detail even if the requested fields omit variants/metadata", async () => {
  const r = await run(filterPublicCatalog, {}, { id: "renamed" })
  expect(r.res.status).toHaveBeenCalledWith(404)
  expect(r.next).not.toHaveBeenCalled()
})
it.each([
  ["new cart", guardNewCartItems, { items: [{ variant_id: "v_raw" }] }],
  ["add line", guardAddedCartItem, { variant_id: "v_parent" }],
  [
    "availability",
    guardInventoryVariants,
    { lines: [{ variant_id: "v_raw" }] },
  ],
  [
    "substitution",
    guardInventoryResolution,
    {
      resolutions: [{ action: "substitute", replacement_variant_id: "v_raw" }],
    },
  ],
  [
    "waitlist",
    guardInventoryResolution,
    { resolutions: [{ action: "waitlist", original_variant_id: "v_raw" }] },
  ],
])("blocks %s before its mutation", async (_label, guard, body) => {
  const r = await run(guard, body)
  expect(r.res.status).toHaveBeenCalledWith(400)
  expect(r.next).not.toHaveBeenCalled()
})
it.each([
  ["update line", guardUpdatedCartItem, {}, { id: "cart", line_id: "line" }],
  ["native complete", guardCompletedCart, {}, { id: "cart" }],
  [
    "custom checkout/payment collection",
    guardCompletedCart,
    { cart_id: "cart" },
    {},
  ],
])(
  "blocks an existing internal cart at %s",
  async (_label, guard, body, params) => {
    graph.mockResolvedValue({
      data: [{ id: "cart", items: [{ id: "line", variant_id: "v_raw" }] }],
    })
    const r = await run(guard, body, params)
    expect(r.res.status).toHaveBeenCalledWith(400)
    expect(r.next).not.toHaveBeenCalled()
  }
)
it("blocks payment-session creation for an internal item before provider access", async () => {
  graph
    .mockResolvedValueOnce({ data: [{ cart_id: "cart" }] })
    .mockResolvedValueOnce({
      data: [{ id: "cart", items: [{ id: "line", variant_id: "v_raw" }] }],
    })
  const r = await run(guardCartPaymentSession, {}, { id: "collection" })
  expect(r.res.status).toHaveBeenCalledWith(400)
  expect(r.next).not.toHaveBeenCalled()
})
it("allows removal of an internal line, without waitlisting or adding it", async () => {
  const r = await run(guardInventoryResolution, {
    resolutions: [{ action: "remove", original_variant_id: "v_raw" }],
  })
  expect(r.next).toHaveBeenCalledTimes(1)
})
it("fails closed on database, cart-graph and middleware-ordering failure", async () => {
  const unavailable = {
    resolve: () => {
      throw new Error("sensitive DB diagnostic")
    },
  }
  const a = await run(
    guardAddedCartItem,
    { variant_id: "v_retail" },
    {},
    unavailable
  )
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  await filterPublicCatalog({ scope, params: {} } as any, res, next)
  expect(res.status).toHaveBeenCalledWith(503)
  expect(next).not.toHaveBeenCalled()
  graph.mockRejectedValue(new Error("graph unavailable"))
  const c = await run(guardCompletedCart, { cart_id: "cart" })
  for (const r of [a, c]) {
    expect(r.res.status).toHaveBeenCalledWith(503)
    expect(r.next).not.toHaveBeenCalled()
    expect(JSON.stringify(r.res.json.mock.calls)).not.toContain("sensitive")
  }
})
