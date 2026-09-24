import { model } from "@medusajs/framework/utils";

const ReceiptSnapshot = model
  .define("gp_receipt_snapshot", {
    id: model.id({ prefix: "gprs" }).primaryKey(),
    cart_id: model.text(),
    customer_id: model.text().nullable(),
    email: model.text(),
    contact_revision: model.number(),
    source: model.text(),
  })
  .indexes([{ name: "IDX_gp_receipt_snapshot_cart", on: ["cart_id"] }]);
export default ReceiptSnapshot;
