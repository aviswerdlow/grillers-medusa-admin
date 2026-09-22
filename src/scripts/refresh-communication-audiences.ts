import type { ExecArgs } from "@medusajs/framework/types"
import { refreshSegmentMembership } from "../lib/communications/admin"

/** Release warm-up/recovery. This does not run the sending maintenance path. */
export default async function refreshCommunicationAudiences({ container }: ExecArgs) {
  const result = await refreshSegmentMembership(container)
  container.resolve("logger").info(`[communications-audiences] ${JSON.stringify(result)}`)
  if (result.unavailable) throw new Error("Audience refresh unavailable; sending stays held")
}
