import { Migration } from "@mikro-orm/migrations";

export class Migration20260920235000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table gp_order_publication drop constraint gp_order_publication_kind_check;
      alter table gp_order_publication add constraint gp_order_publication_kind_check
        check (kind in ('placed','finalized','canceled','fulfillment_created','shipped','delivered','return_requested','refunded'));
      alter table gp_order_publication drop constraint gp_order_publication_order_id_kind_key;
      create unique index gp_order_publication_original_unique on gp_order_publication(order_id,kind)
        where kind in ('placed','finalized');
      create unique index gp_order_publication_lifecycle_unique on gp_order_publication(order_id,kind,source_id)
        where kind not in ('placed','finalized');
      alter table gp_order_publication add constraint gp_order_publication_lifecycle_source_check
        check (kind in ('placed','finalized') or source_id is not null);
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain lifecycle evidence and delivery receipts; disable the publisher for rollback"
    );
  }
}
