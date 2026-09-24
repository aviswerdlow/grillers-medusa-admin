import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http";
import { prepareReceiptSnapshot } from "../../lib/receipt-email-orders";
import { ReceiptEmailError } from "../../lib/receipt-email";
export async function prepareReceiptEmailCompletion(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    await prepareReceiptSnapshot(req.scope, String(req.params.id));
    return next();
  } catch (e) {
    return res
      .status(e instanceof ReceiptEmailError ? e.status : 503)
      .json({
        message:
          e instanceof ReceiptEmailError
            ? e.message
            : "Could not confirm the receipt email. Please retry checkout.",
      });
  }
}
