import { Migration } from "@mikro-orm/migrations";
import { ORDER_PROMISE_SQL } from "../../../lib/order-promise-schema";

export class Migration20260920174500 extends Migration {
  async up(): Promise<void> {
    this.addSql(ORDER_PROMISE_SQL);
  }

  async down(): Promise<void> {
    throw new Error(
      "Retain accepted-order evidence during rollback; use the reviewed recovery procedure."
    );
  }
}
