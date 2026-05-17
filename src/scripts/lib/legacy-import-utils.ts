import fs from "node:fs"
import path from "node:path"

export type CliArgs = {
  _: string[]
  [key: string]: string | boolean | string[]
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const args: CliArgs = { _: [] }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (!arg.startsWith("--")) {
      args._.push(arg)
      continue
    }

    if (arg.startsWith("--no-")) {
      args[arg.slice(5)] = false
      continue
    }

    const eq = arg.indexOf("=")
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }

    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args[key] = next
      i += 1
      continue
    }

    args[key] = true
  }

  return args
}

export function getStringArg(
  args: CliArgs,
  names: string[],
  fallback?: string
): string | undefined {
  for (const name of names) {
    const value = args[name]
    if (typeof value === "string" && value.length) {
      return value
    }
  }
  return fallback
}

export function getNumberArg(
  args: CliArgs,
  names: string[],
  fallback: number
): number {
  const raw = getStringArg(args, names)
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function getBooleanArg(
  args: CliArgs,
  names: string[],
  fallback = false
): boolean {
  for (const name of names) {
    const value = args[name]
    if (typeof value === "boolean") {
      return value
    }
    if (typeof value === "string") {
      return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase())
    }
  }
  return fallback
}

export function parseEnvFile(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8")

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const idx = line.indexOf("=")
    if (idx <= 0) {
      continue
    }

    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

export function loadFirstExistingEnvFile(candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const resolved = path.resolve(candidate)
    if (fs.existsSync(resolved)) {
      parseEnvFile(resolved)
      return resolved
    }
  }

  return null
}

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

export function toText(value: unknown): string | null {
  const normalized = String(value ?? "").trim()
  return normalized.length ? normalized : null
}

export function normalizeEmail(value: unknown): string | null {
  const normalized = toText(value)?.toLowerCase() ?? null
  if (!normalized || !normalized.includes("@")) {
    return null
  }
  return normalized
}

export function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "")
  if (!digits) {
    return null
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1)
  }

  return digits
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  if (value && typeof (value as any).toNumber === "function") {
    return Number((value as any).toNumber())
  }

  if (value && typeof (value as any).valueOf === "function") {
    const parsed = Number((value as any).valueOf())
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

export function isTruthyLegacyFlag(value: unknown): boolean {
  return ["1", "true", "yes", "y", "active"].includes(
    String(value ?? "").trim().toLowerCase()
  )
}

export function compact<T>(values: Array<T | null | undefined | false>): T[] {
  return values.filter(Boolean) as T[]
}

export function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((v): v is string => !!v)))
}

export function isoDate(value: unknown): string | null {
  const text = toText(value)
  if (!text) {
    return null
  }

  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}
