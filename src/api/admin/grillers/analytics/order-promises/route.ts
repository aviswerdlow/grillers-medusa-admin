import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { requestStaffPrincipal } from "../../../../../lib/staff-principal";
import { readOrderPromisePage } from "../../../../../lib/order-promise-reader";
import { OrderPromiseError } from "../../../../../lib/order-promise";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  const principal = requestStaffPrincipal(req);
  // Also guard direct handler invocation: no staff gateway, broad discovery
  // key or native admin fallback may gain this integration scope implicitly.
  if (principal?.kind !== "service" || principal.service_scope !== "parity")
    return res.status(403).json({ code: "original_reader_required" });
  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    return res.json(await readOrderPromisePage(db, req.query));
  } catch (error) {
    // Never serialize SQL errors, contacts, private promises or credentials.
    return res.status(error instanceof OrderPromiseError ? error.status : 503)
      .json({ code: error instanceof OrderPromiseError ? error.code : "original_read_unavailable" });
  }
}
