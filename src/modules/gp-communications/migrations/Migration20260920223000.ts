import { Migration } from "@mikro-orm/migrations";
import { publicationCheckSql } from "../../../lib/order-publication-migration";

export class Migration20260920223000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ${publicationCheckSql("target", [
        "jitsu",
        "gp_analytics",
        "communications",
        "communications_automation",
        "jitsu_rehearsal",
        "gp_analytics_rehearsal",
      ])}
      create table if not exists gp_order_publication_route (
        target text primary key check (target in ('jitsu_rehearsal','gp_analytics_rehearsal')),
        route_hash text not null,
        created_at timestamptz not null default now()
      );
      insert into gp_order_publication_delivery (event_id, target)
        select p.event_id, t.target from gp_order_publication p
        cross join (values ('jitsu_rehearsal'), ('gp_analytics_rehearsal')) t(target)
        where p.state = 'ready' and p.properties->'test_order' = 'true'::jsonb
        on conflict (event_id,target) do nothing;
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      "Retain rehearsal delivery receipts; disable rehearsal transport for rollback"
    );
  }
}
