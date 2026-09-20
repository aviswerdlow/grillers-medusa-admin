import { contactObject, hasContactConfirmation, PRIMARY_CONTACT_KEY } from "./customer-contact-state"

/** #337 consumes this identity boundary; conflicting rows need its manifest. */
export async function findLegacyImportCustomer(db: any, sourceId: string, email: string) {
  const bySource = await db("customer").whereNull("deleted_at")
    .whereRaw("metadata->>'legacy_source' = ? and metadata->>'legacy_customer_id' = ?", ["legacy_site_customers", sourceId])
  if (bySource.length > 1) throw new Error("legacy_contact_conflict:duplicate_source_identity")
  if (bySource.length === 1) {
    if (String(bySource[0].email).toLowerCase() !== email) throw new Error("legacy_contact_conflict:source_email_changed")
    return bySource[0]
  }
  const byEmail = await db("customer").whereNull("deleted_at").whereRaw("lower(email) = ?", [email])
  if (byEmail.length) throw new Error("legacy_contact_conflict:email_requires_reviewed_mapping")
  return null
}

export function legacyContactImportPatch(existing: any, source: { legacyCustomerId: string; phone?: string | null }, importedAt: string) {
  const metadata = contactObject(existing?.metadata)
  const previous = contactObject(metadata.migration_provenance_v1)
  const confirmed = Boolean(metadata[PRIMARY_CONTACT_KEY]) || hasContactConfirmation(metadata)
  return {
    phone: !confirmed && !existing?.phone && source.phone ? source.phone : undefined,
    metadata: { migration_provenance_v1: {
      version: 1, source: "legacy_site_customers", source_customer_id: source.legacyCustomerId,
      first_imported_at: previous.first_imported_at || importedAt,
      last_seen_at: importedAt,
      // Reading a row is not proof of a source cutoff. #337 supplies its
      // approved watermark/run manifest; never invent one from target time.
      source_watermark: previous.source_watermark ?? null,
      import_run_id: previous.import_run_id ?? null,
    } },
  }
}
