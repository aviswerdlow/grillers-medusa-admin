import crypto from "crypto";

type KnexLike = any;
type Row = Record<string, any>;

const RECEIPT_KEY = "membership_refresh_v1";
const MAX_MEMBERS = 10000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function hash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export function segmentDefinitionHash(definition: unknown) {
  return hash(definition || {});
}

export class SegmentAudienceUnavailable extends Error {
  constructor(public readonly reason: string) {
    super(
      `Segment audience unavailable: ${reason}. Refresh the audience before sending.`
    );
    this.name = "SegmentAudienceUnavailable";
  }
}

export function segmentMembershipState(
  segment: Row | null | undefined,
  at = new Date()
) {
  const receipt = segment?.metadata?.[RECEIPT_KEY];
  let reason: string | null = null;
  const completed = new Date(receipt?.completed_at || "").getTime();
  if (!segment || segment.deleted_at || segment.status !== "active")
    reason = "inactive";
  else if (!receipt || receipt.status !== "available")
    reason = "latest_refresh_unavailable";
  else if (
    receipt.definition_hash !== segmentDefinitionHash(segment.query_definition)
  )
    reason = "definition_changed";
  else if (
    !Number.isFinite(completed) ||
    completed > at.getTime() ||
    at.getTime() - completed > MAX_AGE_MS
  )
    reason = "refresh_expired";
  else if (
    !receipt.refresh_id ||
    !receipt.member_set_hash ||
    !Number.isInteger(receipt.member_count) ||
    receipt.member_count < 0 ||
    receipt.member_count > MAX_MEMBERS ||
    Number(segment.cached_count) !== receipt.member_count ||
    new Date(segment.last_computed_at || "").getTime() !== completed
  )
    reason = "receipt_incomplete";
  return { available: reason === null, reason, receipt: receipt || null };
}

/** A selection receipt proves a complete computation, never consent or test provenance. */
export async function readMaterializedSegmentMembers(
  db: KnexLike,
  segmentId: string,
  at?: Date
) {
  return db.transaction(async (trx: KnexLike) => {
    const segment = await trx("gp_segment")
      .where("id", segmentId)
      .forShare()
      .first();
    const state = segmentMembershipState(segment, at || new Date());
    if (!state.available) throw new SegmentAudienceUnavailable(state.reason!);
    const members: Row[] = await trx("gp_segment_member")
      .where("segment_id", segmentId)
      .whereNull("deleted_at")
      .whereNull("exited_at")
      .select("profile_id", "metadata");
    const profileIds = [
      ...new Set(members.map((member) => String(member.profile_id))),
    ].sort();
    if (
      members.some(
        (member) =>
          member.metadata?.[RECEIPT_KEY]?.refresh_id !==
          state.receipt.refresh_id
      ) ||
      profileIds.length !== members.length ||
      profileIds.length !== state.receipt.member_count ||
      hash(profileIds) !== state.receipt.member_set_hash
    ) {
      throw new SegmentAudienceUnavailable("membership_changed");
    }
    return { segment, profileIds, receipt: state.receipt };
  });
}

/** Locks the definition through evaluation and records failures without erasing the prior rows. */
export async function refreshMaterializedSegment(
  db: KnexLike,
  segmentId: string,
  evaluate: (trx: KnexLike, definition: Row) => Promise<string[]>
): Promise<{
  status: "available" | "unavailable" | "inactive";
  member_count: number;
}> {
  return db.transaction(async (trx: KnexLike) => {
    const segment = await trx("gp_segment")
      .where("id", segmentId)
      .forUpdate()
      .first();
    if (!segment || segment.deleted_at || segment.status !== "active")
      return { status: "inactive", member_count: 0 };
    const attemptedAt = new Date();
    const refreshId = crypto.randomUUID();
    const base = {
      refresh_id: refreshId,
      attempted_at: attemptedAt.toISOString(),
      definition_hash: segmentDefinitionHash(segment.query_definition),
    };
    try {
      // A savepoint makes a failed query/write recoverable inside the outer
      // transaction, so the unavailable receipt can still commit atomically.
      return await trx.transaction(async (work: KnexLike) => {
        const evaluated = await evaluate(work, segment.query_definition || {});
        if (
          !Array.isArray(evaluated) ||
          evaluated.some((id) => typeof id !== "string" || !id.trim())
        ) {
          throw new SegmentAudienceUnavailable("invalid_membership");
        }
        const profileIds = [...new Set(evaluated)].sort();
        if (profileIds.length > MAX_MEMBERS)
          throw new SegmentAudienceUnavailable("audience_too_large");
        const completedAt = new Date();
        const receipt = {
          ...base,
          status: "available",
          completed_at: completedAt.toISOString(),
          member_count: profileIds.length,
          member_set_hash: hash(profileIds),
        };
        const existing: Row[] = await work("gp_segment_member")
          .where("segment_id", segmentId)
          .whereNull("deleted_at")
          .whereNull("exited_at")
          .select("id", "profile_id", "metadata");
        const existingIds = new Set(existing.map((row) => row.profile_id));
        if (existingIds.size !== existing.length)
          throw new SegmentAudienceUnavailable("duplicate_membership");
        const nextIds = new Set(profileIds);
        const exits = existing
          .filter((row) => !nextIds.has(row.profile_id))
          .map((row) => row.id);
        const retained = existing
          .filter((row) => nextIds.has(row.profile_id))
          .map((row) => row.id);
        if (exits.length)
          await work("gp_segment_member")
            .whereIn("id", exits)
            .update({ exited_at: completedAt, updated_at: completedAt });
        if (retained.length) {
          await work("gp_segment_member")
            .whereIn("id", retained)
            .update({
              metadata: work.raw(
                "coalesce(metadata, '{}'::jsonb) || ?::jsonb",
                [JSON.stringify({ [RECEIPT_KEY]: { refresh_id: refreshId } })]
              ),
              updated_at: completedAt,
            });
        }
        const inserts = profileIds
          .filter((profileId) => !existingIds.has(profileId))
          .map((profileId) => ({
            id: `gpsegmem_${crypto.randomUUID()}`,
            segment_id: segmentId,
            profile_id: profileId,
            entered_at: completedAt,
            created_at: completedAt,
            updated_at: completedAt,
            metadata: { [RECEIPT_KEY]: { refresh_id: refreshId } },
          }));
        for (let offset = 0; offset < inserts.length; offset += 500)
          await work("gp_segment_member").insert(
            inserts.slice(offset, offset + 500)
          );
        await work("gp_segment")
          .where("id", segmentId)
          .update({
            cached_count: profileIds.length,
            last_computed_at: completedAt,
            updated_at: completedAt,
            metadata: { ...(segment.metadata || {}), [RECEIPT_KEY]: receipt },
          });
        return {
          status: "available" as const,
          member_count: profileIds.length,
        };
      });
    } catch (error) {
      await trx("gp_segment")
        .where("id", segmentId)
        .update({
          metadata: {
            ...(segment.metadata || {}),
            [RECEIPT_KEY]: {
              ...base,
              status: "unavailable",
              reason:
                error instanceof SegmentAudienceUnavailable
                  ? error.reason
                  : "source_or_storage_unavailable",
            },
          },
          updated_at: new Date(),
        });
      return { status: "unavailable", member_count: 0 };
    }
  });
}
