import { Migration } from "@mikro-orm/migrations"

export class Migration20260924214500 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table if not exists "gp_institutional_override_attempt" (
        "id" uuid not null,
        "order_id" text not null,
        "actor_id" text null,
        "reason_code" text not null,
        "authority_reason" text not null,
        "named_capability" text null,
        "decision" text not null default 'denied',
        "created_at" timestamptz not null default now(),
        constraint "gp_institutional_override_attempt_pkey" primary key ("id"),
        constraint "gp_institutional_override_attempt_denied" check (decision = 'denied')
      );
    `)
    this.addSql(`
      create index if not exists "IDX_gp_institutional_override_attempt_order"
      on "gp_institutional_override_attempt" ("order_id", "created_at");
    `)
  }

  async down(): Promise<void> {
    throw new Error("Retain denied institutional release attempts during rollback; use the reviewed recovery procedure.")
  }
}
