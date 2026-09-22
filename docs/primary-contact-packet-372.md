# Primary-contact compatibility

Default behavior change: ordinary communications profile upserts retain the legacy email association while `GP_PRIMARY_CONTACT_ENABLED` is off. The identity-conflict rejection is active when the feature is enabled, whenever an existing profile has accepted primary-contact state, and unconditionally inside the contact transaction. Accepted contact records cannot downgrade on rollback.

The storefront SMS marketing form must use `/store/customers/me/contact` with the displayed revision and request ID. Its legacy fallback is limited to 404 and unattested customers and sends only newly chosen consent fields, never staff metadata. A current subscription preselects the phone editor checkbox only for that same phone; changing the phone clears the choice.

Validation: PostgreSQL regression cases cover default-off association, enabled rejection, accepted-record rollback and explicit contact-transaction strictness. Existing contact transactions still guard revisions, replay, stable account identity and historical order destinations. No new migration or live change is included.
