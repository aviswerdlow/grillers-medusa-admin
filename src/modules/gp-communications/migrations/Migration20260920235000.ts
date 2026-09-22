import { Migration } from "@mikro-orm/migrations";
import { publicationCheckSql } from "../../../lib/order-publication-migration";

export class Migration20260920235000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      do $$ begin
        if not exists (select 1 from pg_constraint where conrelid = 'gp_order_publication'::regclass and conname = 'gp_order_publication_lifecycle_source_check') then
          alter table gp_order_publication add constraint gp_order_publication_lifecycle_source_check
            check (kind in ('placed','finalized') or source_id is not null);
        end if;
      end; $$;
      create unique index if not exists gp_order_publication_original_unique on gp_order_publication(order_id,kind)
        where kind in ('placed','finalized');
      create unique index if not exists gp_order_publication_lifecycle_unique on gp_order_publication(order_id,kind,source_id)
        where kind not in ('placed','finalized');
      alter table gp_order_publication drop constraint if exists gp_order_publication_order_id_kind_key;
      ${publicationCheckSql("kind", [
        "placed",
        "finalized",
        "canceled",
        "fulfillment_created",
        "shipped",
        "delivered",
        "return_requested",
        "refunded",
      ])}
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain lifecycle evidence and delivery receipts; disable the publisher for rollback"
    );
  }
}
