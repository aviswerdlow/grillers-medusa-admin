import { model } from "@medusajs/framework/utils";

const ReceiptContact = model
  .define("gp_receipt_contact", {
    id: model.id({ prefix: "gprc" }).primaryKey(),
    customer_id: model.text(),
    revision: model.number().default(0),
    active_email: model.text().nullable(),
    active_verified_at: model.dateTime().nullable(),
    pending_challenge_id: model.text().nullable(),
    last_requested_at: model.dateTime().nullable(),
    request_window_start: model.dateTime().nullable(),
    request_count: model.number().default(0),
    last_revoke_request_id: model.text().nullable(),
  })
  .indexes([
    {
      name: "UQ_gp_receipt_contact_customer",
      on: ["customer_id"],
      unique: true,
    },
    {
      name: "UQ_gp_receipt_contact_active_email",
      on: ["active_email"],
      unique: true,
      where: "active_email is not null",
    },
  ]);
export default ReceiptContact;
