import { Migration } from "@mikro-orm/migrations"
import { QBD_POSTING_OUTBOX_SQL } from "../../../lib/qbd-posting-schema"

export class Migration20260919183000 extends Migration {
  async up(): Promise<void> {
    // Deliberately no historical backfill or automatic posting replay.
    this.addSql(QBD_POSTING_OUTBOX_SQL)
  }

  async down(): Promise<void> {
    // Accounting history must survive an application rollback.
    throw new Error("Retain gp_qbd_posting_outbox during rollback; use the documented recovery procedure.")
  }
}
