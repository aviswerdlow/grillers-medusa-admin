type ExperimentLineContext = Record<
  string,
  {
    variant_key: string
    assignment_id: string
    version?: string | null
    evaluation_version?: string | null
    surface?: string
    impact?: string
    route_market?: string
    customer_type?: string
    source?: string
    anonymous_id?: string
    session_id?: string
    user_id?: string
  }
>

type ExperimentEventIdentity = {
  anonymous_id?: string
  session_id?: string
  user_id?: string
  route_market?: string
  customer_type?: string
}

function parseContext(value: unknown): ExperimentLineContext {
  const candidate =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value)
          } catch {
            return null
          }
        })()
      : value

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {}
  }

  const context: ExperimentLineContext = {}

  for (const [experimentKey, assignment] of Object.entries(candidate)) {
    if (
      !assignment ||
      typeof assignment !== "object" ||
      Array.isArray(assignment)
    ) {
      continue
    }

    const record = assignment as Record<string, unknown>
    if (
      typeof record.variant_key !== "string" ||
      typeof record.assignment_id !== "string"
    ) {
      continue
    }

    context[experimentKey] = {
      variant_key: record.variant_key,
      assignment_id: record.assignment_id,
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      ...(typeof record.evaluation_version === "string" ? { evaluation_version: record.evaluation_version } : {}),
      ...(typeof record.surface === "string"
        ? { surface: record.surface }
        : {}),
      ...(typeof record.impact === "string" ? { impact: record.impact } : {}),
      ...(typeof record.route_market === "string"
        ? { route_market: record.route_market }
        : {}),
      ...(typeof record.customer_type === "string"
        ? { customer_type: record.customer_type }
        : {}),
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(typeof record.anonymous_id === "string"
        ? { anonymous_id: record.anonymous_id }
        : {}),
      ...(typeof record.session_id === "string"
        ? { session_id: record.session_id }
        : {}),
      ...(typeof record.user_id === "string" ? { user_id: record.user_id } : {}),
    }
  }

  return context
}

export function experimentContextFromItem(item: any) {
  return parseContext(item?.metadata?.experiment_context)
}

export function experimentContextFromItems(items: any[] | undefined | null) {
  const context: ExperimentLineContext = {}

  for (const item of items || []) {
    Object.assign(context, experimentContextFromItem(item))
  }

  return Object.keys(context).length ? context : undefined
}

export function experimentIdentityFromItems(items: any[] | undefined | null) {
  const identity: ExperimentEventIdentity = {}

  for (const item of items || []) {
    const context = experimentContextFromItem(item)

    for (const assignment of Object.values(context)) {
      if (!identity.anonymous_id && assignment.anonymous_id) {
        identity.anonymous_id = assignment.anonymous_id
      }
      if (!identity.session_id && assignment.session_id) {
        identity.session_id = assignment.session_id
      }
      if (!identity.user_id && assignment.user_id) {
        identity.user_id = assignment.user_id
      }
      if (!identity.route_market && assignment.route_market) {
        identity.route_market = assignment.route_market
      }
      if (!identity.customer_type && assignment.customer_type) {
        identity.customer_type = assignment.customer_type
      }
    }
  }

  return Object.keys(identity).length ? identity : undefined
}
