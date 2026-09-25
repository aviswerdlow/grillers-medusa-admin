import { Migration } from "@mikro-orm/migrations"

export class Migration20260924213000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table "gp_institutional_credit_commitment"
      drop constraint if exists "gp_institutional_credit_state_valid";
    `)
    this.addSql(`
      alter table "gp_institutional_credit_commitment"
      add constraint "gp_institutional_credit_state_valid"
      check (state in ('accepted', 'posting', 'posted', 'cancelled', 'reconciled', 'quarantined'));
    `)
  }

  async down(): Promise<void> {
    throw new Error("Retain quarantined institutional commitments during rollback; use the reviewed recovery procedure.")
  }
}
