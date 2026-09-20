import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  IncomingStockConflict,
  IncomingStockInvalid,
  listIncomingStock,
} from "../../../../../lib/incoming-stock";
import { incomingStockStaffCommand } from "../../../../../lib/incoming-stock-staff";
import {
  requestStaffPrincipal,
  StaffAccessDenied,
} from "../../../../../lib/staff-principal";

function failure(res: MedusaResponse, error: any) {
  const denied = error instanceof StaffAccessDenied,
    invalid = error instanceof IncomingStockInvalid,
    conflict =
      error instanceof IncomingStockConflict || error?.code === "23505";
  return res
    .status(denied ? 403 : invalid ? 422 : conflict ? 409 : 503)
    .json({
      message:
        denied || invalid || error instanceof IncomingStockConflict
          ? error.message
          : conflict
          ? "This source or request is already recorded. Refresh before continuing."
          : "Incoming stock was not confirmed. Refresh and check the recorded request before retrying.",
    });
}
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const principal = requestStaffPrincipal(req);
    if (
      !principal ||
      principal.kind === "service" ||
      (principal.kind !== "operator" &&
        !principal.capabilities.has("inventory.read"))
    )
      throw new StaffAccessDenied("Verified inventory access is required.");
    return res.json(
      await listIncomingStock(
        req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        req.query.variant_id as string
      )
    );
  } catch (error) {
    return failure(res, error);
  }
}
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const principal = requestStaffPrincipal(req);
    if (!principal)
      throw new StaffAccessDenied("Verified staff access is required.");
    return res.json(
      await incomingStockStaffCommand(
        req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        req.scope.resolve(ContainerRegistrationKeys.QUERY),
        principal,
        (req.body || {}) as Record<string, any>
      )
    );
  } catch (error) {
    return failure(res, error);
  }
}
