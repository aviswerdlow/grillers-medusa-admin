import { Migration } from "@mikro-orm/migrations";
import { ORDER_PUBLICATION_SQL } from "../../../lib/order-publication-schema";

export class Migration20260920214500 extends Migration {
  async up(): Promise<void> {
    this.addSql(ORDER_PUBLICATION_SQL);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain publication and delivery receipts; disable the worker for rollback"
    );
  }
}
