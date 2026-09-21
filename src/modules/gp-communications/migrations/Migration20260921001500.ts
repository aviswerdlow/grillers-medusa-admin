import { Migration } from "@mikro-orm/migrations";
import { REFUND_PROVIDER_SQL } from "../../../lib/refund-provider-schema";
export class Migration20260921001500 extends Migration {
  async up(): Promise<void> {
    this.addSql(REFUND_PROVIDER_SQL);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain refund evidence, queue and scope; disable reconciliation for rollback"
    );
  }
}
