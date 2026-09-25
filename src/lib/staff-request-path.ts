/** Express changes req.url and req.path inside app.use(matcher); originalUrl retains the request target. */
export function staffRequestPath(req: { originalUrl?: unknown; url?: unknown; path?: unknown }): string {
  const value = req.originalUrl ?? req.url ?? req.path
  return typeof value === "string" ? value.split("?", 1)[0] : ""
}

/** Staff route grants use the literal URL path, never Express's decoded or case-insensitive match. */
export function isCanonicalStaffPath(path: string): boolean {
  return path.startsWith("/") && path.length > 1 && path === path.toLowerCase()
    && !path.includes("//") && !path.includes("%") && !path.endsWith("/")
}
