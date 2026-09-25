/** Express changes req.url and req.path inside app.use(matcher); originalUrl retains the request target. */
export function staffRequestPath(req: { originalUrl?: unknown; url?: unknown; path?: unknown }): string {
  const value = req.originalUrl ?? req.url ?? req.path
  // A raw fragment can be routed by Express on the prefix while evading a
  // suffix guard. Reject it even when it appears after the query delimiter.
  return typeof value === "string" && !value.includes("#") ? value.split("?", 1)[0] : ""
}

/** Keep ID segments literal; callers match only fixed route parts case-insensitively. */
export function isCanonicalStaffPath(path: string): boolean {
  return path.startsWith("/") && path.length > 1 && !path.endsWith("/")
    && !/[#;%\\]/.test(path) && !path.includes("//")
    && !path.split("/").some(segment => segment === "." || segment === "..")
}
