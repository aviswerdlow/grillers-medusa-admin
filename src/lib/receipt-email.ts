import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export class ReceiptEmailError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const RECEIPT_CHALLENGE_MINUTES = 15;
const object = (v: any): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
export const receiptEmail = (v: unknown) =>
  typeof v === "string" ? v.trim().toLowerCase() : "";
const fail = (status: number, code: string, message: string): never => {
  throw new ReceiptEmailError(status, code, message);
};
export type ReceiptRequest =
  | { action: "verify"; challenge_id: string; code: string }
  | {
      action: "request" | "revoke";
      email: string;
      expected_revision: number;
      request_id: string;
    };
export function parseReceiptRequest(body: any): ReceiptRequest {
  const b = object(body),
    email = receiptEmail(b.email);
  if (b.action !== "request" && b.action !== "verify" && b.action !== "revoke")
    fail(400, "invalid_action", "Choose a receipt email action.");
  if (b.action === "verify") {
    if (
      typeof b.challenge_id !== "string" ||
      b.challenge_id.length > 80 ||
      typeof b.code !== "string" ||
      b.code.length > 100
    )
      fail(400, "invalid_code", "Enter the code from your email.");
    return { action: "verify", challenge_id: b.challenge_id, code: b.code };
  }
  if (
    !Number.isSafeInteger(b.expected_revision) ||
    b.expected_revision < 0 ||
    typeof b.request_id !== "string" ||
    !/^[a-zA-Z0-9_-]{16,96}$/.test(b.request_id)
  )
    fail(400, "invalid_request", "Refresh the page and try again.");
  if (
    b.action === "request" &&
    (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
  )
    fail(400, "invalid_email", "Enter a valid email address.");
  return {
    action: b.action === "request" ? "request" : "revoke",
    email,
    expected_revision: b.expected_revision,
    request_id: b.request_id,
  };
}

const codeHash = (
  id: string,
  customerId: string,
  email: string,
  code: string
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "receipt-email-v1",
        id,
        customerId,
        email,
        code.replace(/[\s-]/g, "").toUpperCase(),
      ])
    )
    .digest("hex");
const timestamp = (date: any) => (date ? new Date(date).toISOString() : null);

async function lockCustomer(trx: any, customerId: string) {
  const customer = await trx("customer")
    .where({ id: customerId })
    .whereNull("deleted_at")
    .forUpdate()
    .first();
  if (!customer) fail(401, "sign_in", "Please sign in again.");
  await trx("gp_receipt_contact")
    .insert({ id: `gprc_${randomUUID()}`, customer_id: customerId })
    .onConflict("customer_id")
    .ignore();
  const contact = await trx("gp_receipt_contact")
    .where({ customer_id: customerId })
    .forUpdate()
    .first();
  return { customer, contact };
}
async function audit(
  trx: any,
  customerId: string,
  action: string,
  properties: Record<string, any>
) {
  const now = new Date();
  await trx("gp_communication_event").insert({
    id: `gpcevt_${randomUUID()}`,
    event_id: `receipt:${randomUUID()}`,
    event_name: `receipt_email_${action}`,
    source: "medusa-customer",
    medusa_customer_id: customerId,
    occurred_at: now,
    received_at: now,
    properties,
    created_at: now,
    updated_at: now,
  });
}
export async function receiptSuppressed(db: any, email: string) {
  return Boolean(
    await db("gp_suppression_preference")
      .where({ email_lower: email })
      .whereNull("deleted_at")
      .whereNull("resubscribed_at")
      .whereIn("scope", ["global", "hard_bounce", "complaint"])
      .first()
  );
}
async function collision(db: any, customerId: string, email: string) {
  const otherCustomer = await db("customer")
    .whereNull("deleted_at")
    .whereRaw("lower(email) = ?", [email])
    .whereNot("id", customerId)
    .first();
  const otherReceipt = await db("gp_receipt_contact")
    .where({ active_email: email })
    .whereNot("customer_id", customerId)
    .first();
  return Boolean(otherCustomer || otherReceipt);
}
export async function getReceiptEmailState(db: any, customerId: string) {
  const customer = await db("customer")
    .where({ id: customerId })
    .whereNull("deleted_at")
    .first();
  if (!customer) fail(401, "sign_in", "Please sign in again.");
  const c = await db("gp_receipt_contact")
    .where({ customer_id: customerId })
    .first();
  const pending = c?.pending_challenge_id
    ? await db("gp_receipt_challenge")
        .where({ id: c.pending_challenge_id, customer_id: customerId })
        .first()
    : null;
  const login = receiptEmail(customer.email),
    active = c?.active_email || login;
  const customerMetadata = object(customer.metadata);
  const suggestion = receiptEmail(
    object(customerMetadata.preferred_contact_email_request).email ||
      customerMetadata.preferred_contact_email
  );
  return {
    revision: Number(c?.revision || 0),
    login_email: login,
    active_email: active,
    active_source: c?.active_email ? "verified_preference" : "sign_in_email",
    active_status: (await receiptSuppressed(db, active))
      ? "delivery_problem"
      : "active",
    verified_at: timestamp(c?.active_verified_at),
    suggested_email:
      !c ||
      (Date.parse(
        object(customerMetadata.preferred_contact_email_request).requested_at ||
          ""
      ) > new Date(c.updated_at).getTime() &&
        suggestion !== c.active_email &&
        suggestion !== pending?.email)
        ? suggestion || null
        : null,
    pending:
      pending && ["pending", "locked"].includes(pending.status)
        ? {
            id: pending.id,
            email: pending.email,
            status:
              pending.status === "locked"
                ? "locked"
                : new Date(pending.expires_at).getTime() <= Date.now()
                ? "expired"
                : ["failed", "suppressed"].includes(pending.delivery_status) ||
                  (await receiptSuppressed(db, pending.email))
                ? "delivery_problem"
                : "pending",
            expires_at: timestamp(pending.expires_at),
            retry_at: c?.last_requested_at
              ? new Date(
                  new Date(c.last_requested_at).getTime() + 60_000
                ).toISOString()
              : null,
          }
        : null,
  };
}

/** Customer lock serializes requests/activation/revoke. The challenge table stores only a hash; delivery receives the code. */
export async function requestReceiptEmail(
  db: any,
  customerId: string,
  input: { email: string; expected_revision: number; request_id: string }
) {
  const email = receiptEmail(input.email);
  return db.transaction(async (trx: any) => {
    const { contact } = await lockCustomer(trx, customerId);
    const replay = await trx("gp_receipt_challenge")
      .where({ customer_id: customerId, request_id: input.request_id })
      .first();
    if (replay) {
      if (replay.email !== email)
        fail(
          409,
          "request_conflict",
          "Refresh before requesting another code."
        );
      return { replayed: true, challenge: null };
    }
    if (Number(contact.revision) !== input.expected_revision)
      fail(
        409,
        "contact_changed",
        "Your receipt settings changed. Refresh before saving."
      );
    const now = new Date(),
      windowStart = contact.request_window_start
        ? new Date(contact.request_window_start).getTime()
        : 0;
    const count =
      now.getTime() - windowStart < 3_600_000
        ? Number(contact.request_count)
        : 0;
    if (
      (contact.last_requested_at &&
        now.getTime() - new Date(contact.last_requested_at).getTime() <
          60_000) ||
      count >= 5
    )
      fail(
        429,
        "wait_before_resend",
        "Please wait before requesting another code. You can request up to five per hour."
      );
    if (contact.pending_challenge_id)
      await trx("gp_receipt_challenge")
        .where({ id: contact.pending_challenge_id, status: "pending" })
        .update({ status: "replaced", updated_at: now });
    const id = `gprv_${randomUUID()}`,
      code = randomBytes(8).toString("hex").toUpperCase();
    await trx("gp_receipt_challenge").insert({
      id,
      customer_id: customerId,
      email,
      request_id: input.request_id,
      token_hash: codeHash(id, customerId, email, code),
      expires_at: new Date(now.getTime() + RECEIPT_CHALLENGE_MINUTES * 60_000),
      status: "pending",
      delivery_status: "requested",
    });
    await trx("gp_receipt_contact")
      .where({ id: contact.id })
      .update({
        pending_challenge_id: id,
        revision: Number(contact.revision) + 1,
        last_requested_at: now,
        request_window_start: count ? contact.request_window_start : now,
        request_count: count + 1,
        updated_at: now,
      });
    await audit(trx, customerId, "requested", {
      revision: Number(contact.revision) + 1,
      challenge_id: id,
    });
    // Check collisions only after the requesting account proves mailbox possession.
    // The request response never reveals whether another account uses the address.
    return { replayed: false, challenge: { id, email, code } };
  });
}

export async function verifyReceiptEmail(
  db: any,
  customerId: string,
  challengeId: string,
  code: string
) {
  const result = await db.transaction(async (trx: any) => {
    const { contact } = await lockCustomer(trx, customerId);
    const challenge = await trx("gp_receipt_challenge")
      .where({ id: challengeId, customer_id: customerId })
      .forUpdate()
      .first();
    const invalid = {
      status: 400,
      code: "invalid_code",
      message:
        "This code is invalid or expired. Request a new code from your profile.",
    };
    if (
      !challenge ||
      challenge.id !== contact.pending_challenge_id ||
      challenge.status !== "pending" ||
      new Date(challenge.expires_at).getTime() <= Date.now() ||
      challenge.attempts >= 5 ||
      challenge.delivery_status === "held"
    )
      return invalid;
    const attempts = Number(challenge.attempts) + 1,
      now = new Date();
    const expected = Buffer.from(challenge.token_hash, "hex"),
      actual = Buffer.from(
        codeHash(challenge.id, customerId, challenge.email, code),
        "hex"
      );
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      await trx("gp_receipt_challenge")
        .where({ id: challenge.id })
        .update({
          attempts,
          status: attempts >= 5 ? "locked" : "pending",
          updated_at: now,
        });
      return invalid;
    }
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `receipt-email:${challenge.email}`,
    ]);
    if (
      (await collision(trx, customerId, challenge.email)) ||
      (await receiptSuppressed(trx, challenge.email))
    )
      return {
        status: 409,
        code: "address_unavailable",
        message:
          "This address cannot be activated here. Use another address or contact customer service.",
      };
    await trx("gp_receipt_challenge").where({ id: challenge.id }).update({
      status: "verified",
      attempts,
      consumed_at: now,
      token_hash: null,
      updated_at: now,
    });
    await trx("gp_receipt_contact")
      .where({ id: contact.id })
      .update({
        active_email: challenge.email,
        active_verified_at: now,
        pending_challenge_id: null,
        revision: Number(contact.revision) + 1,
        updated_at: now,
      });
    await audit(trx, customerId, "verified", {
      revision: Number(contact.revision) + 1,
      challenge_id: challenge.id,
      previous_email: contact.active_email || null,
      email: challenge.email,
    });
    return null;
  });
  if (result) fail(result.status, result.code, result.message);
}

export async function revokeReceiptEmail(
  db: any,
  customerId: string,
  input: { expected_revision: number; request_id: string }
) {
  await db.transaction(async (trx: any) => {
    const { contact } = await lockCustomer(trx, customerId);
    if (contact.last_revoke_request_id === input.request_id) return;
    if (Number(contact.revision) !== input.expected_revision)
      fail(
        409,
        "contact_changed",
        "Your receipt settings changed. Refresh before saving."
      );
    const now = new Date();
    if (contact.pending_challenge_id)
      await trx("gp_receipt_challenge")
        .where({ id: contact.pending_challenge_id, status: "pending" })
        .update({ status: "revoked", token_hash: null, updated_at: now });
    await trx("gp_receipt_contact")
      .where({ id: contact.id })
      .update({
        active_email: null,
        active_verified_at: null,
        pending_challenge_id: null,
        revision: Number(contact.revision) + 1,
        last_revoke_request_id: input.request_id,
        updated_at: now,
      });
    await audit(trx, customerId, "revoked", {
      revision: Number(contact.revision) + 1,
      previous_email: contact.active_email || null,
    });
  });
}

export async function selectedReceipt(
  db: any,
  customerId: string | null,
  guestEmail: string
) {
  if (!customerId)
    return {
      email: receiptEmail(guestEmail),
      revision: 0,
      source: "checkout_email",
    };
  const customer = await db("customer")
    .where({ id: customerId })
    .whereNull("deleted_at")
    .first();
  if (!customer)
    fail(
      409,
      "customer_unavailable",
      "Refresh your account before placing this order."
    );
  const contact = await db("gp_receipt_contact")
    .where({ customer_id: customerId })
    .first();
  return {
    email: contact?.active_email || receiptEmail(customer.email),
    revision: Number(contact?.revision || 0),
    source: contact?.active_email ? "verified_preference" : "sign_in_email",
  };
}
