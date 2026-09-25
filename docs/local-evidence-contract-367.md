# Private local delivery evidence (#367)

`GP_LOCAL_MILESTONES_ENABLED` defaults off. This PR adds a separate Medusa
file-provider implementation for delivery photos. Medusa 2.10.3's FILE module
requires exactly one provider, so the existing public S3 provider and its
customer-media variables remain unchanged. The evidence module uses a dedicated
private bucket and rejects a bucket name equal to the public-media bucket.
The upload command omits ACL entirely. This is required for Supabase
compatibility and also avoids public-object grants on Railway Storage.

## API and custody

Only a current named office/operator or the assigned driver on a local-delivery
order can use these `/admin` routes. Every request checks the current #318 staff
principal and the #59 assignment row again, including when the wider staff
boundary is in observation mode. Service credentials are denied. The #438 path
fix remains a prerequisite to merging #59.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/admin/grillers/local-milestones/orders/:id/evidence` | Order-scoped metadata including pending uploads; no object keys |
| `PUT` | `/admin/grillers/local-milestones/orders/:id/evidence/:uploadId` | JPEG/PNG/WebP/HEIC image bytes; headers `Content-Type`, `x-gp-evidence-size`, `x-gp-evidence-sha256` |
| `GET` | `/admin/grillers/local-milestones/orders/:id/evidence/:uploadId` | A 60-second signed GET URL, after fresh authorization |

The API caps raw bytes at 10 MiB, checks the declared size, SHA-256 and file
signature, then calls the private provider. It stores a pending ledger row
before reading bytes. A disconnected or failed upload remains pending for
retry with the same upload ID; an existing ID with changed metadata is a
conflict. A completed retry checks bytes and returns the same evidence ID.
The S3 upload receives a 30-second abort signal while `complete()` holds the
ledger row lock, so a stalled upload does not hold a database connection
indefinitely. An interrupted upload keeps its pending identity for retry.
No upload response contains a public URL or object key. The signed link is a
bearer link; staff should retrieve it only when needed and never paste it into
logs or a public ticket.

`GP_LOCAL_EVIDENCE_RETENTION_DAYS` is optional. Unset means no automatic
deletion of stored photos while the retention owner/policy remains unresolved.
When a valid 120–3650 day value is configured, expiry is recalculated from each
photo's `stored_at`, including photos uploaded before the policy was set; the
worker updates their `retain_until` projections and drains all due rows in
batches. It deletes each private object before marking its ledger row deleted.
Pending uploads older than seven days are also swept, even without a photo
retention policy. A row lock keeps that sweep from racing an in-flight retry;
a failed object deletion leaves the row retryable on the next run. The ledger
keeps the order, actor, hash, size and timestamps. The retention job remains
off with the master flag.
The photo is order-associated; #359 still controls when a photo is required,
which no-photo exceptions are permitted, and how it links to a completion
event. A photo upload alone never advances an order milestone.

## Release order

1. Provider PR #62 is merged and its migration applied. Merge the retention
   follow-up from `main` with green exact-head CI before enabling the master
   flag. No bucket or Railway variable changes occur in this follow-up.
2. Avi approved a Railway Storage Bucket in the `grillers` project on #367.
   After provider path-style PR #79 merges, create one **private** bucket in
   the production environment. Set only `GP_LOCAL_EVIDENCE_BUCKET`,
   `GP_LOCAL_EVIDENCE_S3_ENDPOINT`, `GP_LOCAL_EVIDENCE_S3_REGION`,
   `GP_LOCAL_EVIDENCE_S3_ACCESS_KEY_ID` and
   `GP_LOCAL_EVIDENCE_S3_SECRET_ACCESS_KEY` on Railway API and worker. A
   retention value requires the recorded owner/policy. The optional
   `GP_LOCAL_EVIDENCE_S3_FORCE_PATH_STYLE` defaults to `false` for Railway;
   PR #79 supplies this behavior. Read back variable **names**, bucket privacy
   and triggered deploy without posting values.
3. With a controlled test object, prove an unauthenticated public GET is
   denied, a signed GET works then expires, and delete that object. Post the
   receipts on #367. Activation remains gated by #359, #320 and #332.

If the production compatibility proof fails because of SDK checksum headers,
set the private provider's S3 client
`requestChecksumCalculation` and `responseChecksumValidation` to
`WHEN_REQUIRED`, then repeat the proof. Do not infer compatibility from unit
tests or change the public file provider.

CI tests cover the no-ACL command, signed TTL, default-off behavior, public
bucket and missing-setting guards, unauthenticated API denial, byte limits,
content checks, retry after a failed provider call, and retention pruning.
The production private-bucket readback and signed-link expiry proof must wait
until step 2.
