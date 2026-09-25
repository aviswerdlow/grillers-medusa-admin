import { Migration } from "@mikro-orm/migrations"

export class Migration20260925190000 extends Migration {
  async up(): Promise<void> {
    this.addSql('alter table "gp_import_run" add column if not exists "batch_id" text null;')
    this.addSql('create unique index if not exists "UQ_gp_import_run_source_batch" on "gp_import_run" ("source", "batch_id") where batch_id is not null;')
  }

  async down(): Promise<void> {
    throw new Error("Import batch identity is durable audit evidence; use a reviewed restore plan")
  }
}
