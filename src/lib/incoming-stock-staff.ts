import {
  configuredIds,
  staffCapabilities,
  staffSessionIsCurrent,
} from "./staff-access-policy";
import { StaffAccessDenied, type StaffPrincipal } from "./staff-principal";
import {
  IncomingStockInvalid,
  createIncomingBatch,
  reviseIncomingBatch,
  stageIncomingReceipt,
} from "./incoming-stock";
import { qbdListIdFromMetadata } from "./inventory-allocation";

/** No implicit grant to office/warehouse roles before #359 names the operator. */
export async function incomingStockStaffCommand(
  db: any,
  query: any,
  principal: StaffPrincipal,
  body: Record<string, any>
) {
  if (
    !configuredIds("GP_INCOMING_STOCK_OPERATOR_IDS").has(principal.id) ||
    principal.kind === "service"
  )
    throw new StaffAccessDenied(
      "Incoming stock requires an explicitly approved receiving operator."
    );
  return db.transaction(async (trx: any) => {
    if (principal.kind === "customer") {
      const actor = await trx("customer")
        .where({ id: principal.id })
        .whereNull("deleted_at")
        .forUpdate()
        .first();
      if (
        !actor ||
        !staffCapabilities(actor).has("inventory.manage") ||
        !staffSessionIsCurrent(actor, principal.auth)
      )
        throw new StaffAccessDenied(
          "Your receiving access changed. Sign in again."
        );
    } else if (!configuredIds("GP_PRIVILEGED_ADMIN_USER_IDS").has(principal.id))
      throw new StaffAccessDenied("This operator is no longer approved.");
    const command = {
      request_id: body.request_id,
      actor: { id: principal.id, reason: body.reason },
    };
    if (body.action === "create") {
      if (typeof body.variant_id !== "string" || !body.variant_id.trim())
        throw new IncomingStockInvalid("Choose a verified variant.");
      const { data } = await query.graph({
        entity: "product_variant",
        fields: ["id", "metadata", "product.metadata"],
        filters: { id: body.variant_id },
      });
      const variant = data?.find((row: any) => row.id === body.variant_id);
      const listId =
        variant &&
        qbdListIdFromMetadata(variant.metadata, variant.product?.metadata);
      if (
        !listId ||
        (body.qbd_list_id !== undefined && body.qbd_list_id !== listId)
      )
        throw new IncomingStockInvalid(
          "The variant needs a verified matching QuickBooks ListID."
        );
      return createIncomingBatch(trx, {
        ...command,
        variant_id: variant.id,
        qbd_list_id: listId,
        stock_unit: body.stock_unit,
        source_system: body.source_system,
        source_ref: body.source_ref,
        expected_quantity: body.expected_quantity,
        usable_at: body.usable_at,
      });
    }
    if (["confirm", "revise", "cancel"].includes(body.action))
      return reviseIncomingBatch(trx, {
        ...command,
        batch_id: body.batch_id,
        expected_revision: body.expected_revision,
        action: body.action,
        confirmed_quantity: body.confirmed_quantity,
        usable_at: body.usable_at,
      });
    if (body.action === "stage_receipt")
      return stageIncomingReceipt(trx, {
        ...command,
        batch_id: body.batch_id,
        expected_revision: body.expected_revision,
        source_system: body.source_system,
        source_ref: body.source_ref,
        quantity: body.quantity,
        usable_at: body.usable_at,
      });
    throw new IncomingStockInvalid(
      "Choose create, confirm, revise, cancel or stage_receipt. Stock application and customer commitments are not staff body commands."
    );
  });
}
