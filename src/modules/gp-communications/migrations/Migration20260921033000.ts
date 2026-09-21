import { Migration } from "@mikro-orm/migrations";

export class Migration20260921033000 extends Migration {
  async up(): Promise<void> {
    this
      .addSql(`alter table gp_order_publication drop constraint gp_order_publication_kind_check;
      alter table gp_order_publication add constraint gp_order_publication_kind_check
      check (kind in ('placed','finalized','canceled','fulfillment_created','shipped','delivered',
        'return_requested','refunded','refund_updated','shipping_forecast','inventory_created','inventory_released'));`);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain operational measurement evidence; disable the publisher for rollback"
    );
  }
}
