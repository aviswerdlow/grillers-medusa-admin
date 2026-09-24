import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getReceiptEmailState,
  requestReceiptEmail,
  verifyReceiptEmail,
  revokeReceiptEmail,
} from "../../src/lib/receipt-email";
import {
  prepareReceiptSnapshot,
  validateReceiptSnapshot,
  resolveOrderReceiptEmail,
  RECEIPT_SNAPSHOT_KEY,
} from "../../src/lib/receipt-email-orders";
import {
  sendTrackedEmail,
  upsertCustomerProfile,
} from "../../src/lib/communications/core";
import { Migration20260920121500 } from "../../src/modules/gp-communications/migrations/Migration20260920121500";
import { Migration20260526120000 } from "../../src/modules/gp-communications/migrations/Migration20260526120000";
jest.mock(
  "../../src/lib/communications/destinations.js",
  () => ({ writeEventDestinations: async () => {} }),
  { virtual: true }
);
jest.mock(
  "../../src/lib/communications/queue.js",
  () => ({ enqueueCommunicationEvent: async () => true }),
  { virtual: true }
);
const knex = require("knex"),
  schema = `gp_receipt_${randomUUID().replace(/-/g, "")}`;
let db: any, admin: any;
const cid = "cus_receipt",
  login = "login@example.invalid",
  alternate = "receipts@example.invalid";
const notification = {
  createNotifications: jest.fn(async (_input: any) => [
    { provider_id: "synthetic-provider-id" },
  ]),
};
const container = {
  resolve: (key: string) =>
    key === ContainerRegistrationKeys.PG_CONNECTION
      ? db
      : key === Modules.NOTIFICATION
      ? notification
      : { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
} as any;
beforeAll(async () => {
  const connection =
    process.env.RECEIPT_TEST_DATABASE_URL ||
    (process.env.RECEIPT_TEST_PG_SOCKET
      ? {
          host: process.env.RECEIPT_TEST_PG_SOCKET,
          port: 55466,
          user: "gp_receipt_test",
          database: "gp_receipts",
        }
      : null);
  if (!connection)
    throw new Error("Explicit isolated receipt-test database required");
  admin = knex({ client: "pg", connection });
  await admin.raw(`create schema ${schema}`);
  db = knex({
    client: "pg",
    connection,
    searchPath: [schema],
    pool: { min: 0, max: 8 },
  });
  const native = fs.readFileSync(
    path.join(
      path.dirname(require.resolve("@medusajs/customer/package.json")),
      "dist/migrations/Migration20240124154000.js"
    ),
    "utf8"
  );
  const customerSql = native.match(
    /this\.addSql\('([^']*create table if not exists "customer"[^']*)'\)/
  )?.[1];
  if (!customerSql) throw new Error("Native customer table not found");
  await db.raw(customerSql);
  // Cart/order-link fixtures exercise the persisted contract, not the full native checkout workflow.
  await db.raw(
    "create table cart (id text primary key, customer_id text, email text, metadata jsonb, completed_at timestamptz, deleted_at timestamptz, updated_at timestamptz)"
  );
  await db.raw(
    "create table order_cart (order_id text primary key, cart_id text)"
  );
  const migrationDir = path.join(
    process.cwd(),
    "src/modules/gp-communications/migrations"
  );
  for (const file of fs
    .readdirSync(migrationDir)
    .filter((f) => /^Migration.*\.ts$/.test(f))
    .sort()) {
    const migration: any = Object.values(
      require(path.join(migrationDir, file))
    )[0];
    const sql: string[] = [];
    await migration.prototype.up.call({
      addSql: (s: string) => sql.push(s),
    } as any);
    for (const statement of sql) await db.raw(statement);
  }
});
afterAll(async () => {
  if (db) await db.destroy();
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`);
    await admin.destroy();
  }
});
beforeEach(async () => {
  notification.createNotifications.mockClear();
  for (const table of [
    "gp_receipt_contact",
    "gp_receipt_challenge",
    "gp_receipt_snapshot",
    "gp_suppression_preference",
    "gp_communication_event",
    "gp_message_log",
    "gp_identity_map",
    "gp_customer_profile",
    "order_cart",
    "cart",
    "customer",
  ])
    await db(table).delete();
  await db("customer").insert({
    id: cid,
    email: login,
    metadata: {
      preferred_contact_email_request: {
        email: alternate,
        status: "pending_verification",
      },
    },
  });
});
const request = (email = alternate, revision = 0, id = randomUUID()) =>
  requestReceiptEmail(db, cid, {
    email,
    expected_revision: revision,
    request_id: id,
  });
async function activate(email = alternate, revision = 0) {
  const r = await request(email, revision);
  await verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code);
  return r;
}
const state = () => getReceiptEmailState(db, cid);

it("keeps pending separate and activates only for the requesting account without rewriting identity", async () => {
  expect((await state()).suggested_email).toBe(alternate);
  const r = await request();
  expect((await state()).active_email).toBe(login);
  await db("customer").insert({
    id: "cus_other",
    email: "other@example.invalid",
  });
  await expect(
    verifyReceiptEmail(db, "cus_other", r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 400 });
  await verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code);
  expect(await state()).toMatchObject({
    active_email: alternate,
    active_source: "verified_preference",
    pending: null,
    suggested_email: null,
  });
  expect((await db("customer").where({ id: cid }).first()).email).toBe(login);
  const row = await db("gp_receipt_challenge")
    .where({ id: r.challenge!.id })
    .first();
  expect(row.token_hash).toBeNull();
  expect(row.status).toBe("verified");
  expect(JSON.stringify(await state())).not.toContain(r.challenge!.code);
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 400 });
});
it("serializes duplicate requests and never returns a second delivery code", async () => {
  const id = randomUUID(),
    results = await Promise.all([
      request(alternate, 0, id),
      request(alternate, 0, id),
    ]);
  expect(results.filter((r) => r.challenge)).toHaveLength(1);
  expect(await db("gp_receipt_challenge")).toHaveLength(1);
  await expect(request("changed@example.invalid", 1, id)).rejects.toMatchObject(
    { status: 409 }
  );
});
it("limits resend and expires/replaces codes without deactivating the current receipt", async () => {
  await activate();
  const old = await state();
  await expect(
    request("new@example.invalid", old.revision)
  ).rejects.toMatchObject({ status: 429 });
  await db("gp_receipt_contact").update({
    last_requested_at: new Date(Date.now() - 61_000),
  });
  const r = await request("new@example.invalid", old.revision);
  expect((await state()).active_email).toBe(alternate);
  await db("gp_receipt_challenge")
    .where({ id: r.challenge!.id })
    .update({ expires_at: new Date(Date.now() - 1) });
  expect((await state()).pending?.status).toBe("expired");
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 400 });
  await db("gp_receipt_contact").update({
    last_requested_at: new Date(Date.now() - 61_000),
  });
  const fresh = await request("new@example.invalid", (await state()).revision);
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 400 });
  await verifyReceiptEmail(db, cid, fresh.challenge!.id, fresh.challenge!.code);
  expect((await state()).active_email).toBe("new@example.invalid");
});
it("commits failed attempts and locks the fifth attempt", async () => {
  const r = await request();
  for (let i = 0; i < 5; i++)
    await expect(
      verifyReceiptEmail(db, cid, r.challenge!.id, "invalid-code")
    ).rejects.toMatchObject({ status: 400 });
  expect((await state()).pending?.status).toBe("locked");
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 400 });
  expect((await state()).active_email).toBe(login);
});
it("keeps account collisions generic until proof and never merges accounts", async () => {
  await db("customer").insert({ id: "cus_other", email: alternate });
  const r = await request();
  expect(r.challenge).toBeTruthy();
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 409, code: "address_unavailable" });
  expect((await state()).active_email).toBe(login);
  expect(await db("customer")).toHaveLength(2);
});
it("serializes two verified claims to the same destination", async () => {
  await db("customer").insert({
    id: "cus_other",
    email: "other@example.invalid",
  });
  const first = await request(),
    second = await requestReceiptEmail(db, "cus_other", {
      email: alternate,
      expected_revision: 0,
      request_id: randomUUID(),
    });
  const result = await Promise.allSettled([
    verifyReceiptEmail(db, cid, first.challenge!.id, first.challenge!.code),
    verifyReceiptEmail(
      db,
      "cus_other",
      second.challenge!.id,
      second.challenge!.code
    ),
  ]);
  expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(
    await db("gp_receipt_contact").where({ active_email: alternate })
  ).toHaveLength(1);
});
it("rolls back activation when its audit cannot be committed", async () => {
  const r = await request();
  await db.raw(
    "alter table gp_communication_event add constraint reject_receipt_verify check (event_name <> 'receipt_email_verified')"
  );
  try {
    await expect(
      verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
    ).rejects.toThrow();
  } finally {
    await db.raw(
      "alter table gp_communication_event drop constraint reject_receipt_verify"
    );
  }
  expect((await state()).active_email).toBe(login);
  expect((await db("gp_receipt_challenge").first()).status).toBe("pending");
});
it("shows delivery problems and refuses a suppressed new destination", async () => {
  const r = await request();
  await db("gp_suppression_preference").insert({
    id: "supp_test",
    email: alternate,
    email_lower: alternate,
    scope: "hard_bounce",
    reason: "test",
  });
  expect((await state()).pending?.status).toBe("delivery_problem");
  await expect(
    verifyReceiptEmail(db, cid, r.challenge!.id, r.challenge!.code)
  ).rejects.toMatchObject({ status: 409 });
});
it("freezes accepted recipients and keeps legacy orders independent of today's profile", async () => {
  await activate();
  await db("cart").insert({
    id: "cart_test",
    customer_id: cid,
    email: login,
    metadata: { shipping_packing_plan_v1: { kept: true } },
  });
  await prepareReceiptSnapshot(container, "cart_test");
  let cart = await db("cart").first();
  await validateReceiptSnapshot(container, cart);
  await prepareReceiptSnapshot(container, "cart_test");
  expect(await db("gp_receipt_snapshot")).toHaveLength(1);
  expect(cart.metadata.shipping_packing_plan_v1).toEqual({ kept: true });
  await db("order_cart").insert({ order_id: "order_test", cart_id: cart.id });
  await db("cart").update({ completed_at: new Date() });
  await revokeReceiptEmail(db, cid, {
    expected_revision: (await state()).revision,
    request_id: randomUUID(),
  });
  expect((await state()).active_email).toBe(login);
  await prepareReceiptSnapshot(container, "cart_test");
  expect(await db("gp_receipt_snapshot")).toHaveLength(1);
  expect(
    await resolveOrderReceiptEmail(container, {
      id: "order_test",
      customer_id: cid,
      email: login,
      metadata: cart.metadata,
    })
  ).toBe(alternate);
  expect(
    await resolveOrderReceiptEmail(container, {
      id: "legacy_order",
      customer_id: cid,
      email: "historical@example.invalid",
      metadata: {},
    })
  ).toBe("historical@example.invalid");
});
it("rejects stale receipt selection and forged cross-cart snapshot pointers", async () => {
  await db("cart").insert({
    id: "cart_test",
    customer_id: cid,
    email: login,
    metadata: {},
  });
  await prepareReceiptSnapshot(container, "cart_test");
  const cart = await db("cart").first();
  await activate();
  await expect(validateReceiptSnapshot(container, cart)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    validateReceiptSnapshot(container, { ...cart, id: "other_cart" })
  ).rejects.toMatchObject({ status: 409 });
  await db("order_cart").insert({
    order_id: "other_order",
    cart_id: "other_cart",
  });
  await expect(
    resolveOrderReceiptEmail(container, {
      id: "other_order",
      customer_id: cid,
      email: login,
      metadata: cart.metadata,
    })
  ).rejects.toThrow("ownership mismatch");
});
it("does not allow metadata/imports to activate or overwrite receipt authority", async () => {
  await activate();
  await db("customer")
    .where({ id: cid })
    .update({
      metadata: {
        receipt_contact: { email: "forged@example.invalid", verified: true },
        preferred_contact_email: "forged@example.invalid",
      },
    });
  expect((await state()).active_email).toBe(alternate);
});
it("delivers a service receipt without moving login or transferring marketing consent", async () => {
  await upsertCustomerProfile(db, {
    medusa_customer_id: cid,
    email: login,
    email_consent: true,
  });
  const sent = await sendTrackedEmail(container, {
    to: alternate,
    medusa_customer_id: cid,
    purpose: "service",
    stream: "transactional",
    template_key: "receipt-email-verification",
    topic: "account",
    idempotency_key: "synthetic-receipt",
    subject: "Synthetic",
    html: "<p>Synthetic</p>",
  });
  expect(sent.ok).toBe(true);
  expect(notification.createNotifications).toHaveBeenCalledTimes(1);
  expect(notification.createNotifications.mock.calls[0][0]).toMatchObject({
    to: alternate,
  });
  const profile = await db("gp_customer_profile")
    .where({ medusa_customer_id: cid })
    .first();
  expect(profile.email).toBe(login);
  expect(profile.email_consent).toBe(true);
  expect(
    (await db("gp_identity_map").where({ medusa_customer_id: cid }).first())
      .email_lower
  ).toBe(login);
  expect((await db("gp_message_log").first()).email).toBe(alternate);
  await sendTrackedEmail(container, {
    to: alternate,
    medusa_customer_id: cid,
    purpose: "broadcast",
    stream: "broadcast",
    template_key: "synthetic-marketing",
    subject: "Never sent",
    html: "<p>Never sent</p>",
  });
  expect(notification.createNotifications).toHaveBeenCalledTimes(1);
});

it("retains historical service delivery after customer soft deletion without adopting the receipt mailbox", async () => {
  await db("customer").where({ id: cid }).update({ deleted_at: new Date() });
  const sent = await sendTrackedEmail(container, {
    to: alternate,
    medusa_customer_id: cid,
    purpose: "service",
    stream: "transactional",
    template_key: "order-refund",
    order_id: "historical-order",
    idempotency_key: "historical-refund",
    subject: "Synthetic refund",
    html: "<p>Synthetic</p>",
  });
  expect(sent.ok).toBe(true);
  expect(notification.createNotifications).toHaveBeenCalledTimes(1);
  expect(
    (await db("gp_customer_profile").where({ medusa_customer_id: cid }).first())
      .email
  ).toBe(login);
  expect((await db("gp_message_log").first()).email).toBe(alternate);
});
