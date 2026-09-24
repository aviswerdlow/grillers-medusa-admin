/** Primary-contact attestation is staged until native mutation/consent rehearsal.
 * Existing confirmed records remain protected when activation is rolled back. */
export function primaryContactEnabled(env = process.env): boolean {
  return env.GP_PRIMARY_CONTACT_ENABLED?.trim().toLowerCase() === "true";
}
export function hasPrimaryContactState(metadata: any): boolean {
  return (
    metadata?.primary_contact_v1 != null ||
    metadata?.contact_confirmation_v2 != null
  );
}
