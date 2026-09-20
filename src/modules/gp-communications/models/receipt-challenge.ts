import { model } from "@medusajs/framework/utils";

const ReceiptChallenge = model
  .define("gp_receipt_challenge", {
    id: model.id({ prefix: "gprv" }).primaryKey(),
    customer_id: model.text(),
    email: model.text(),
    request_id: model.text(),
    token_hash: model.text().nullable(),
    expires_at: model.dateTime(),
    status: model.text().default("pending"),
    delivery_status: model.text().default("requested"),
    attempts: model.number().default(0),
    consumed_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: "UQ_gp_receipt_challenge_request",
      on: ["customer_id", "request_id"],
      unique: true,
    },
  ]);
export default ReceiptChallenge;
