import type { MedusaRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { emitOpsAlert } from "../../../lib/ops-alert";
import { canManageCustomerPaymentMethods } from "../../../lib/staff-access-policy";

export const STRIPE_PROVIDER_ID = "pp_stripe_stripe";
export const DEFAULT_PAYMENT_METHOD_METADATA_KEY = "default_payment_method_id";
export const STAFF_TARGET_CUSTOMER_ID_HEADER = "x-gp-staff-target-customer-id";

type StoreCustomerWithAccountHolders = {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  company_name?: string | null;
  metadata?: Record<string, unknown> | null;
  account_holders?: Array<{
    id: string;
    provider_id: string;
    external_id?: string | null;
    data?: Record<string, any> | null;
  }>;
};

export class PaymentMethodAccessDenied extends Error {}

function normalizedHeaderValue(req: MedusaRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

export function jsonError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  status: number,
  message: string,
) {
  res.status(status).json({ message });
}

function redactedErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:pm|pi|seti|cus)_[A-Za-z0-9_]+/g, "[redacted-stripe-id]")
    .slice(0, 500);
}

function paymentMethodOperation(fallbackMessage: string) {
  const lower = fallbackMessage.toLowerCase();
  if (lower.includes("load")) return "list";
  if (lower.includes("start a card setup")) return "setup_intent";
  if (lower.includes("delete")) return "delete";
  if (lower.includes("default")) return "set_default";
  return "unknown";
}

export async function emitPaymentMethodRouteFailureAlert(input: {
  req: MedusaRequest;
  fallbackMessage: string;
  error: unknown;
  logger?: { warn?: (message: string) => void; error?: (message: string) => void };
}) {
  const authContext = (input.req as any).auth_context || {};
  const staffTargetCustomerId = normalizedHeaderValue(
    input.req,
    STAFF_TARGET_CUSTOMER_ID_HEADER,
  );

  return emitOpsAlert({
    alertKind: "payment_method_route_failed",
    severity: "warn",
    title: `Payment method ${paymentMethodOperation(input.fallbackMessage)} failed`,
    path: "src/api/store/payment-methods",
    source: "medusa-server",
    logger: input.logger as any,
    meta: {
      operation: paymentMethodOperation(input.fallbackMessage),
      actor_id: authContext.actor_id || null,
      has_staff_target_customer_id: Boolean(staffTargetCustomerId),
      staff_target_customer_id: staffTargetCustomerId || null,
      error_message: redactedErrorMessage(input.error),
    },
  });
}

export function handleRouteError(
  req: MedusaRequest,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown,
  fallbackMessage: string,
) {
  if (error instanceof PaymentMethodAccessDenied) {
    jsonError(res, 403, error.message);
    return;
  }
  const logger = req.scope.resolve("logger") as {
    error: (message: string) => void;
    warn?: (message: string) => void;
  };
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[payment-methods] ${fallbackMessage}: ${message}`);
  void emitPaymentMethodRouteFailureAlert({
    req,
    fallbackMessage,
    error,
    logger,
  }).catch(() => {
    // Alerting must never delay or break the account payment-method response.
  });
  jsonError(res, 500, fallbackMessage);
}

async function getCustomerById(req: MedusaRequest, customerId: string) {
  if (!customerId) {
    return null;
  }

  const query = req.scope.resolve("query") as any;
  const { data } = await query.graph({
    entity: "customer",
    fields: [
      "id",
      "email",
      "first_name",
      "last_name",
      "phone",
      "company_name",
      "metadata",
      "account_holders.id",
      "account_holders.provider_id",
      "account_holders.external_id",
      "account_holders.data",
    ],
    filters: { id: customerId },
  });

  return (data?.[0] || null) as StoreCustomerWithAccountHolders | null;
}

export async function getAuthenticatedCustomer(req: MedusaRequest) {
  return getCustomerById(req, (req as any).auth_context?.actor_id);
}

export async function getPaymentContextCustomer(req: MedusaRequest) {
  const authenticatedCustomer = await getAuthenticatedCustomer(req);
  const targetCustomerId = normalizedHeaderValue(
    req,
    STAFF_TARGET_CUSTOMER_ID_HEADER,
  );

  if (!targetCustomerId) {
    return {
      customer: authenticatedCustomer,
      staffCustomer: null as StoreCustomerWithAccountHolders | null,
      staffTargetCustomerId: null as string | null,
    };
  }

  if (!canManageCustomerPaymentMethods(authenticatedCustomer)) {
    throw new PaymentMethodAccessDenied(
      "Staff access required: office permission is needed for customer-context payment methods.",
    );
  }

  const targetCustomer = await getCustomerById(req, targetCustomerId);
  if (!targetCustomer) {
    throw new Error("Customer context target could not be loaded.");
  }

  return {
    customer: targetCustomer,
    staffCustomer: authenticatedCustomer,
    staffTargetCustomerId: targetCustomerId,
  };
}

export function getStripeAccountHolder(
  customer: StoreCustomerWithAccountHolders,
) {
  return customer.account_holders?.find(
    (holder) => holder.provider_id === STRIPE_PROVIDER_ID,
  );
}

export async function getOrCreateStripeAccountHolder(
  req: MedusaRequest,
  customer: StoreCustomerWithAccountHolders,
) {
  const existing = getStripeAccountHolder(customer);
  if (existing) return existing;

  const paymentModule = req.scope.resolve(Modules.PAYMENT) as any;
  const link = req.scope.resolve("link") as any;

  const accountHolder = await paymentModule.createAccountHolder({
    provider_id: STRIPE_PROVIDER_ID,
    context: {
      customer: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        phone: customer.phone,
        company_name: customer.company_name,
      },
    },
  });

  await link.create({
    [Modules.CUSTOMER]: {
      customer_id: customer.id,
    },
    [Modules.PAYMENT]: {
      account_holder_id: accountHolder.id,
    },
  });

  return accountHolder;
}

export async function listStripePaymentMethods(
  req: MedusaRequest,
  customer: StoreCustomerWithAccountHolders,
  accountHolder = getStripeAccountHolder(customer),
) {
  if (!accountHolder) return [];

  const paymentModule = req.scope.resolve(Modules.PAYMENT) as any;
  const defaultPaymentMethodId =
    customer.metadata?.[DEFAULT_PAYMENT_METHOD_METADATA_KEY];

  const paymentMethods = await paymentModule.listPaymentMethods({
    provider_id: STRIPE_PROVIDER_ID,
    context: {
      account_holder: accountHolder,
      customer,
    },
  });

  return paymentMethods.map((method: any) => ({
    id: method.id,
    provider_id: STRIPE_PROVIDER_ID,
    is_default: method.id === defaultPaymentMethodId,
    data: method.data,
  }));
}

export async function assertPaymentMethodBelongsToCustomer(
  req: MedusaRequest,
  customer: StoreCustomerWithAccountHolders,
  paymentMethodId: string,
) {
  const methods = await listStripePaymentMethods(req, customer);
  return methods.some(
    (method: { id: string }) => method.id === paymentMethodId,
  );
}

export async function setCustomerDefaultPaymentMethod(
  req: MedusaRequest,
  customer: StoreCustomerWithAccountHolders,
  paymentMethodId?: string,
) {
  const customerModule = req.scope.resolve(Modules.CUSTOMER) as any;
  const metadata = { ...(customer.metadata || {}) };

  if (paymentMethodId) {
    metadata[DEFAULT_PAYMENT_METHOD_METADATA_KEY] = paymentMethodId;
  } else {
    delete metadata[DEFAULT_PAYMENT_METHOD_METADATA_KEY];
  }

  await customerModule.updateCustomers(customer.id, { metadata });
}

export async function stripeFormRequest<T>(
  path: string,
  body: Record<string, string>,
): Promise<T> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    throw new Error("Stripe secret key is not configured.");
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || "Stripe request failed.");
  }
  return json as T;
}

export function getStripeCustomerId(accountHolder: {
  external_id?: string | null;
  data?: Record<string, any> | null;
}) {
  return accountHolder.data?.id || accountHolder.external_id || null;
}
