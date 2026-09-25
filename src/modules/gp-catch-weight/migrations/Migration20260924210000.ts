import { Migration } from "@mikro-orm/migrations"
import { LOCAL_MILESTONE_SQL } from "../../../lib/local-milestone-schema"

export class Migration20260924210000 extends Migration {
  async up(): Promise<void> {
    this.addSql(LOCAL_MILESTONE_SQL)
  }

  async down(): Promise<void> {
    throw new Error("Retain local milestone and assignment evidence during rollback.")
  }
}
