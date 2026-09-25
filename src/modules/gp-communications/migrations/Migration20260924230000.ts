import { Migration } from "@mikro-orm/migrations"

export class Migration20260924230000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table if not exists gp_local_milestone_notice (
        id text primary key,
        event_id text not null,
        order_id text not null,
        channel text not null check (channel in ('email', 'sms', 'office')),
        destination_hash text not null check (destination_hash ~ '^[a-f0-9]{64}$'),
        policy_version text,
        status text not null check (status in ('attempting', 'sent', 'suppressed', 'deferred', 'needs_reconciliation', 'alerted')),
        message_id text,
        reason text,
        defer_until timestamptz,
        attempted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (event_id, channel, destination_hash)
      );
      create index if not exists gp_local_milestone_notice_deferred on gp_local_milestone_notice(defer_until)
        where status = 'deferred';
    `)
  }

  async down(): Promise<void> {
    throw new Error("Retain local notice attempts and reconciliation history during rollback.")
  }
}
