import { Migration } from "@mikro-orm/migrations";
import { publicationCheckSql } from "../../../lib/order-publication-migration";

export class Migration20260921033000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      publicationCheckSql("kind", [
        "placed",
        "finalized",
        "canceled",
        "fulfillment_created",
        "shipped",
        "delivered",
        "return_requested",
        "refunded",
        "refund_updated",
        "shipping_forecast",
        "inventory_created",
        "inventory_released",
      ])
    );
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain operational measurement evidence; disable the publisher for rollback"
    );
  }
}
