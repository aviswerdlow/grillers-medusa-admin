import { model } from "@medusajs/framework/utils"

const InstitutionalCreditCommitment = model
  .define("gp_institutional_credit_commitment", {
    id: model.id({ prefix: "gpic" }).primaryKey(),
    company_key: model.text(),
    customer_list_id: model.text(),
    order_id: model.text(),
    amount_cents: model.bigNumber().default(0),
    state: model.text().default("accepted"),
    invoice_txn_id: model.text().nullable(),
  })
  .indexes([
    {
      name: "UQ_gp_institutional_commitment_account_order",
      on: ["company_key", "customer_list_id", "order_id"],
      unique: true,
    },
    {
      name: "IDX_gp_institutional_commitment_account",
      on: ["company_key", "customer_list_id"],
    },
  ])

export default InstitutionalCreditCommitment
