import { createHash } from "node:crypto";

export type RehearsalTarget = "jitsu_rehearsal" | "gp_analytics_rehearsal";
export type RehearsalOptions = {
  id?: string;
  jitsuHost?: string;
  jitsuServerSecret?: string;
  gpAnalyticsEndpoint?: string;
  gpAnalyticsServerKey?: string;
};

function receiver(value?: string): URL | null {
  try {
    const url = new URL(value || "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** A separate origin AND key are required. Never fall back to production. */
export function rehearsalRoute(
  target: RehearsalTarget,
  options: RehearsalOptions | undefined,
  production: {
    jitsuHost: string;
    jitsuServerSecret: string;
    gpAnalyticsEndpoint?: string;
    gpAnalyticsServerKey?: string;
  }
) {
  if (!options || !/^[a-z][a-z0-9-]{2,47}$/.test(options.id || "")) return null;
  const jitsu = target === "jitsu_rehearsal";
  const endpoint = receiver(
    jitsu ? options.jitsuHost : options.gpAnalyticsEndpoint
  );
  const productionEndpoint = receiver(
    jitsu ? production.jitsuHost : production.gpAnalyticsEndpoint
  );
  const key = jitsu ? options.jitsuServerSecret : options.gpAnalyticsServerKey;
  const productionKey = jitsu
    ? production.jitsuServerSecret
    : production.gpAnalyticsServerKey;
  if (
    !endpoint ||
    !productionEndpoint ||
    endpoint.origin === productionEndpoint.origin ||
    !key ||
    !productionKey ||
    key === productionKey
  )
    return null;
  const url = `${endpoint.toString().replace(/\/$/, "")}${
    jitsu ? "/api/v1/s2s/event" : "/v1/track"
  }`;
  // Keys may rotate; the receiver and rehearsal identity must not move mid-replay.
  const hash = createHash("sha256")
    .update(JSON.stringify([target, url, options.id]))
    .digest("hex");
  return { url, key, id: options.id!, hash };
}

export async function pinRehearsalRoute(
  db: any,
  target: RehearsalTarget,
  routeHash: string
): Promise<boolean> {
  await db("gp_order_publication_route")
    .insert({ target, route_hash: routeHash })
    .onConflict("target")
    .ignore();
  const existing = await db("gp_order_publication_route")
    .where({ target })
    .first();
  return existing?.route_hash === routeHash;
}
