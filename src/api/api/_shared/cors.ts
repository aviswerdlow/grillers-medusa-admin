import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const DEFAULT_ALLOWED_ORIGINS = [
  "https://grillers-medusa-frontend.vercel.app",
  "https://grillerspride.com",
  "https://www.grillerspride.com",
]

function splitOrigins(value?: string) {
  return (value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function normalizeOrigin(value: string) {
  if (value === "*") return value
  try {
    return new URL(value).origin
  } catch {
    return value.replace(/\/+$/, "")
  }
}

function allowedOrigins() {
  return [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...splitOrigins(process.env.STORE_CORS),
    ...splitOrigins(process.env.COMMUNICATIONS_CORS),
    ...splitOrigins(process.env.STOREFRONT_URL),
    ...splitOrigins(process.env.NEXT_PUBLIC_BASE_URL),
  ].map(normalizeOrigin)
}

function originMatches(pattern: string, origin: string) {
  if (pattern === "*" || pattern === origin) return true
  if (!pattern.includes("*")) return false

  try {
    const patternUrl = new URL(pattern)
    const originUrl = new URL(origin)
    if (patternUrl.protocol !== originUrl.protocol) return false
    const suffix = patternUrl.hostname.replace(/^\*\./, ".")
    return originUrl.hostname.endsWith(suffix)
  } catch {
    return false
  }
}

export function setCorsHeaders(req: MedusaRequest, res: MedusaResponse) {
  const headers = req.headers as any
  const rawOrigin = headers.origin || headers.get?.("origin")
  const origin = rawOrigin ? normalizeOrigin(String(rawOrigin)) : ""
  const match = origin
    ? allowedOrigins().find((candidate) => originMatches(candidate, origin))
    : ""

  if (match) {
    res.setHeader("Access-Control-Allow-Origin", match === "*" ? "*" : origin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, x-api-key"
  )
  res.setHeader("Access-Control-Max-Age", "86400")

  return Boolean(!origin || match)
}
