import { Migration } from "@mikro-orm/migrations"

export class Migration20260924210000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table if not exists "gp_institutional_credit_commitment" (
        "id" text not null,
        "company_key" text not null,
        "customer_list_id" text not null,
        "order_id" text not null,
        "amount_cents" numeric not null default 0,
        "state" text not null default 'accepted',
        "invoice_txn_id" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "gp_institutional_credit_commitment_pkey" primary key ("id"),
        constraint "gp_institutional_credit_amount_valid" check (amount_cents >= 0 and amount_cents = trunc(amount_cents)),
        constraint "gp_institutional_credit_state_valid" check (state in ('accepted', 'posting', 'posted', 'cancelled', 'reconciled'))
      );
    `)
    this.addSql(`
      create unique index if not exists "UQ_gp_institutional_commitment_account_order"
      on "gp_institutional_credit_commitment" ("company_key", "customer_list_id", "order_id");
    `)
    this.addSql(`
      create index if not exists "IDX_gp_institutional_commitment_account"
      on "gp_institutional_credit_commitment" ("company_key", "customer_list_id");
    `)
  }

  async down(): Promise<void> {
    throw new Error(
      "Retain institutional credit commitments during rollback; use the reviewed recovery procedure."
    )
  }
}
