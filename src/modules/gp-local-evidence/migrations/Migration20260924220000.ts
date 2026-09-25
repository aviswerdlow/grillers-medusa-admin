import { Migration } from "@mikro-orm/migrations"

/** SQL-owned ledger; the private object key is never exposed by an API. */
export class Migration20260924220000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table if not exists gp_local_evidence (
      evidence_id text primary key,
      upload_id text not null unique,
      order_id text not null,
      event_id text,
      content_type text not null check (content_type in ('image/jpeg','image/png','image/webp','image/heic')),
      size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
      sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
      object_key text not null unique,
      status text not null check (status in ('pending','stored_private','deleted')),
      uploaded_by text not null,
      created_at timestamptz not null default now(),
      stored_at timestamptz,
      retain_until timestamptz,
      deleted_at timestamptz
    );`)
    this.addSql(`create index if not exists gp_local_evidence_order on gp_local_evidence(order_id, created_at);
      create index if not exists gp_local_evidence_retention on gp_local_evidence(retain_until)
        where status = 'stored_private' and retain_until is not null;`)
  }

  async down(): Promise<void> {
    throw new Error("Private delivery evidence requires an approved retention and recovery plan before removal")
  }
}
