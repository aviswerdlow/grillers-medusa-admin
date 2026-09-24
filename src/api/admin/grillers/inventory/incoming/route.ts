import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  IncomingStockConflict,
  IncomingStockInvalid,
  listIncomingStock,
  listIncomingExceptions,
} from "../../../../../lib/incoming-stock";
import {
  canManageIncomingStock,
  incomingStockStaffCommand,
} from "../../../../../lib/incoming-stock-staff";
import {
  requestStaffPrincipal,
  StaffAccessDenied,
} from "../../../../../lib/staff-principal";

function failure(res: MedusaResponse, error: any) {
  const denied = error instanceof StaffAccessDenied,
    invalid = error instanceof IncomingStockInvalid,
    conflict =
      error instanceof IncomingStockConflict || error?.code === "23505";
  return res.status(denied ? 403 : invalid ? 422 : conflict ? 409 : 503).json({
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
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const result =
      req.query.view === "exceptions"
        ? await listIncomingExceptions(
            db,
            req.query.after as string | undefined
          )
        : await listIncomingStock(db, req.query.variant_id as string);
    if (req.query.view === "exceptions" && result.demands.length) {
      const { data } = await req.scope
        .resolve(ContainerRegistrationKeys.QUERY)
        .graph({
          entity: "product_variant",
          fields: [
            "id",
            "sku",
            "metadata",
            "product.title",
            "product.metadata",
          ],
          filters: {
            id: [...new Set(result.demands.map((row: any) => row.variant_id))],
          },
        });
      result.demands = result.demands.map((row: any) => {
        const variant = data.find((item: any) => item.id === row.variant_id);
        return {
          ...row,
          product_title:
            variant?.metadata?.strapi_title ||
            variant?.product?.metadata?.strapi_title ||
            variant?.product?.title ||
            "Product needs review",
          sku: variant?.sku || "",
        };
      });
    }
    return res.json({
      ...result,
      can_manage: canManageIncomingStock(principal),
    });
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
