# Local evidence storage design (#367)

This PR contains only an interface, validation rules, and an in-memory test double.
There is no upload endpoint, production adapter, provider variable, bucket
creation, signed URL route, or automatic deletion. `GP_LOCAL_MILESTONES_ENABLED`
remains off by default; the interface is not invoked by a runtime path.

The eventual option 1 adapter must use a **dedicated private evidence bucket**.
`PrivateEvidenceObjectStore.putObject` has no ACL parameter because the current
Supabase S3 compatibility layer does not support that header. The adapter must
prove private read denial before activation, store a stable upload ID and
content hash, and issue downloads only after current staff/order authorization
with a signed link no longer than five minutes. Public object URLs are absent
from the interface. JPEG, PNG, WebP, and HEIC inputs have type, byte signature,
hash, and 10 MiB size checks. A pending upload remains visible until a verified
completion. Repeating the same upload ID and bytes returns the same evidence
identity; changing content under that ID fails.

Retention has an explicit days-or-null policy. Null means no automatic deletion.
Any retention setting, real provider adapter, and upload route require Avi's
recorded storage go on strategy issue #367. Fixture photo cases remain pending
for production behavior even though the in-memory contract tests run in CI.
