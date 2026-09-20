const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const count = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))

/** Do not turn an upstream 200/error page or old status contract into healthy data. */
export function validQbSyncStatus(value: unknown): boolean {
  if (
    !record(value) ||
    !record(value.summary) ||
    !record(value.sync_status) ||
    !record(value.orders)
  )
    return false
  if (
    ![
      "total_orders",
      "open",
      "waiting",
      "stale_pending",
      "blocked",
      "error",
      "warning",
      "skipped",
      "synced",
    ].every((key) => count(value.summary[key]))
  )
    return false
  if (
    !Array.isArray(value.orders.data) ||
    !Array.isArray(value.recent_logs) ||
    !["current_page", "per_page", "total", "last_page"].every((key) =>
      count(value.orders[key])
    ) ||
    typeof value.orders.has_more_pages !== "boolean"
  )
    return false
  const health = value.sync_status.health
  if (
    !record(health) ||
    health.version !== 1 ||
    !["fresh", "stale", "unknown", "rejected"].includes(health.state) ||
    !["reported_open", "idle", "unconfirmed"].includes(health.activity) ||
    !instant(health.observed_at) ||
    !count(health.max_age_seconds) ||
    health.max_age_seconds < 60 ||
    health.max_age_seconds > 86400 ||
    !(health.age_seconds === null || count(health.age_seconds)) ||
    !(health.last_auth_at === null || instant(health.last_auth_at)) ||
    !(
      health.last_accepted_auth_at === null ||
      instant(health.last_accepted_auth_at)
    ) ||
    !(health.expires_at === null || instant(health.expires_at)) ||
    typeof health.last_auth_status !== "string" ||
    !(health.issue === null || typeof health.issue === "string")
  )
    return false
  if (
    health.last_auth_at !== null &&
    health.expires_at !== null &&
    Date.parse(health.expires_at) !==
      Date.parse(health.last_auth_at) + health.max_age_seconds * 1000
  )
    return false
  if (
    health.state === "fresh" &&
    (health.last_auth_status !== "success" ||
      health.activity === "unconfirmed" ||
      health.age_seconds === null ||
      health.age_seconds >= health.max_age_seconds ||
      !instant(health.last_auth_at) ||
      !instant(health.expires_at) ||
      Math.floor(
        (Date.parse(health.observed_at) - Date.parse(health.last_auth_at)) /
          1000
      ) !== health.age_seconds)
  )
    return false
  return typeof value.sync_status.active === "boolean"
}
