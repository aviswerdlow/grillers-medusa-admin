import { Modules } from "@medusajs/framework/utils";
import { emitOpsAlert } from "../../../../lib/ops-alert";
import {
  DEFAULT_PAYMENT_METHOD_METADATA_KEY,
  STAFF_TARGET_CUSTOMER_ID_HEADER,
  STRIPE_PROVIDER_ID,
  assertPaymentMethodBelongsToCustomer,
  emitPaymentMethodRouteFailureAlert,
  getPaymentContextCustomer,
  getOrCreateStripeAccountHolder,
  getStripeAccountHolder,
  getStripeCustomerId,
  handleRouteError,
  listStripePaymentMethods,
  setCustomerDefaultPaymentMethod,
} from "../utils";

jest.mock("../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}));

function makeReq(
  resolvers: Record<string, unknown>,
  options: {
    actorId?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return {
    auth_context: options.actorId ? { actor_id: options.actorId } : undefined,
    headers: options.headers || {},
    scope: {
      resolve: jest.fn((key: string) => {
        if (!(key in resolvers)) {
          throw new Error(`Unexpected resolver: ${key}`);
        }
        return resolvers[key];
      }),
    },
  } as any;
}

describe("payment-method route utils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("selects only the Stripe account holder", () => {
    const customer = {
      id: "cus_local",
      account_holders: [
        { id: "ach_other", provider_id: "pp_other", external_id: "other" },
        {
          id: "ach_stripe",
          provider_id: STRIPE_PROVIDER_ID,
          external_id: "cus_123",
        },
      ],
    };

    expect(getStripeAccountHolder(customer as any)).toMatchObject({
      id: "ach_stripe",
      external_id: "cus_123",
    });
  });

  it("prefers provider data id over external id for Stripe customer id", () => {
    expect(
      getStripeCustomerId({
        external_id: "cus_external",
        data: { id: "cus_from_data" },
      }),
    ).toBe("cus_from_data");

    expect(getStripeCustomerId({ external_id: "cus_external" })).toBe(
      "cus_external",
    );
  });

  it("lists Stripe payment methods and marks the stored default", async () => {
    const paymentModule = {
      listPaymentMethods: jest.fn().mockResolvedValue([
        { id: "pm_1", data: { card: { last4: "4242" } } },
        { id: "pm_2", data: { card: { last4: "1881" } } },
      ]),
    };
    const req = makeReq({ [Modules.PAYMENT]: paymentModule });
    const accountHolder = {
      id: "ach_stripe",
      provider_id: STRIPE_PROVIDER_ID,
      data: { id: "cus_stripe" },
    };
    const customer = {
      id: "cus_local",
      metadata: { [DEFAULT_PAYMENT_METHOD_METADATA_KEY]: "pm_2" },
      account_holders: [accountHolder],
    };

    await expect(
      listStripePaymentMethods(req, customer as any),
    ).resolves.toEqual([
      {
        id: "pm_1",
        provider_id: STRIPE_PROVIDER_ID,
        is_default: false,
        data: { card: { last4: "4242" } },
      },
      {
        id: "pm_2",
        provider_id: STRIPE_PROVIDER_ID,
        is_default: true,
        data: { card: { last4: "1881" } },
      },
    ]);

    expect(paymentModule.listPaymentMethods).toHaveBeenCalledWith({
      provider_id: STRIPE_PROVIDER_ID,
      context: {
        account_holder: accountHolder,
        customer,
      },
    });
  });

  it("checks payment method ownership from the authenticated customer's methods", async () => {
    const paymentModule = {
      listPaymentMethods: jest
        .fn()
        .mockResolvedValue([{ id: "pm_owner", data: {} }]),
    };
    const req = makeReq({ [Modules.PAYMENT]: paymentModule });
    const customer = {
      id: "cus_local",
      metadata: {},
      account_holders: [
        {
          id: "ach_stripe",
          provider_id: STRIPE_PROVIDER_ID,
          data: { id: "cus_stripe" },
        },
      ],
    };

    await expect(
      assertPaymentMethodBelongsToCustomer(req, customer as any, "pm_owner"),
    ).resolves.toBe(true);
    await expect(
      assertPaymentMethodBelongsToCustomer(req, customer as any, "pm_other"),
    ).resolves.toBe(false);
  });

  it("updates and clears the default payment method metadata without dropping other metadata", async () => {
    const customerModule = {
      updateCustomers: jest.fn().mockResolvedValue(undefined),
    };
    const req = makeReq({ [Modules.CUSTOMER]: customerModule });
    const customer = {
      id: "cus_local",
      metadata: {
        source: "test",
        [DEFAULT_PAYMENT_METHOD_METADATA_KEY]: "pm_old",
      },
    };

    await setCustomerDefaultPaymentMethod(req, customer as any, "pm_new");
    expect(customerModule.updateCustomers).toHaveBeenLastCalledWith(
      "cus_local",
      {
        metadata: {
          source: "test",
          [DEFAULT_PAYMENT_METHOD_METADATA_KEY]: "pm_new",
        },
      },
    );

    await setCustomerDefaultPaymentMethod(req, customer as any);
    expect(customerModule.updateCustomers).toHaveBeenLastCalledWith(
      "cus_local",
      {
        metadata: { source: "test" },
      },
    );
  });

  it("creates and links a Stripe account holder when the customer does not have one", async () => {
    const accountHolder = {
      id: "ach_new",
      provider_id: STRIPE_PROVIDER_ID,
      data: { id: "cus_new" },
    };
    const paymentModule = {
      createAccountHolder: jest.fn().mockResolvedValue(accountHolder),
    };
    const link = {
      create: jest.fn().mockResolvedValue(undefined),
    };
    const req = makeReq({
      [Modules.PAYMENT]: paymentModule,
      link,
    });
    const customer = {
      id: "cus_local",
      email: "customer@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      phone: "4045550100",
      company_name: null,
      account_holders: [],
    };

    await expect(
      getOrCreateStripeAccountHolder(req, customer as any),
    ).resolves.toEqual(accountHolder);

    expect(paymentModule.createAccountHolder).toHaveBeenCalledWith({
      provider_id: STRIPE_PROVIDER_ID,
      context: {
        customer: {
          id: "cus_local",
          email: "customer@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          phone: "4045550100",
          company_name: null,
        },
      },
    });
    expect(link.create).toHaveBeenCalledWith({
      [Modules.CUSTOMER]: { customer_id: "cus_local" },
      [Modules.PAYMENT]: { account_holder_id: "ach_new" },
    });
  });

  it("resolves payment context to the authenticated customer by default", async () => {
    const staffCustomer = {
      id: "cus_staff",
      email: "staff@example.com",
      metadata: { gp_staff_role: "office" },
    };
    const query = {
      graph: jest.fn().mockResolvedValue({ data: [staffCustomer] }),
    };
    const req = makeReq({ query }, { actorId: "cus_staff" });

    await expect(getPaymentContextCustomer(req)).resolves.toEqual({
      customer: staffCustomer,
      staffCustomer: null,
      staffTargetCustomerId: null,
    });

    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "customer",
        filters: { id: "cus_staff" },
      }),
    );
  });

  it("lets staff resolve payment context to the impersonated customer", async () => {
    const staffCustomer = {
      id: "cus_staff",
      email: "staff@example.com",
      metadata: { gp_staff_role: "office" },
    };
    const targetCustomer = {
      id: "cus_target",
      email: "meyer@example.com",
      metadata: {},
    };
    const customers = {
      cus_staff: staffCustomer,
      cus_target: targetCustomer,
    } as Record<string, unknown>;
    const query = {
      graph: jest.fn(({ filters }: any) => ({
        data: customers[filters.id] ? [customers[filters.id]] : [],
      })),
    };
    const req = makeReq(
      { query },
      {
        actorId: "cus_staff",
        headers: { [STAFF_TARGET_CUSTOMER_ID_HEADER]: "cus_target" },
      },
    );

    await expect(getPaymentContextCustomer(req)).resolves.toEqual({
      customer: targetCustomer,
      staffCustomer,
      staffTargetCustomerId: "cus_target",
    });
  });

  it("uses an explicitly configured immutable bootstrap customer ID for payment context", async () => {
    const originalBootstrap = process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS
    process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS = "cus_peter"
    const staffCustomer = {
      id: "cus_peter",
      email: "PeterSwerdlow@gmail.com",
      metadata: { role: "customer" },
    };
    const targetCustomer = {
      id: "cus_target",
      email: "meyer@example.com",
      metadata: {},
    };
    const customers = {
      cus_peter: staffCustomer,
      cus_target: targetCustomer,
    } as Record<string, unknown>;
    const query = {
      graph: jest.fn(({ filters }: any) => ({
        data: customers[filters.id] ? [customers[filters.id]] : [],
      })),
    };
    const req = makeReq(
      { query },
      {
        actorId: "cus_peter",
        headers: { [STAFF_TARGET_CUSTOMER_ID_HEADER]: "cus_target" },
      },
    );

    await expect(getPaymentContextCustomer(req)).resolves.toEqual({
      customer: targetCustomer,
      staffCustomer,
      staffTargetCustomerId: "cus_target",
    });
    if (originalBootstrap === undefined) delete process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS
    else process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS = originalBootstrap
  });

  it("blocks customer-context payment access for non-staff customers", async () => {
    const normalCustomer = {
      id: "cus_normal",
      email: "normal@example.com",
      metadata: {},
    };
    const targetCustomer = {
      id: "cus_target",
      email: "meyer@example.com",
      metadata: {},
    };
    const customers = {
      cus_normal: normalCustomer,
      cus_target: targetCustomer,
    } as Record<string, unknown>;
    const query = {
      graph: jest.fn(({ filters }: any) => ({
        data: customers[filters.id] ? [customers[filters.id]] : [],
      })),
    };
    const req = makeReq(
      { query },
      {
        actorId: "cus_normal",
        headers: { [STAFF_TARGET_CUSTOMER_ID_HEADER]: "cus_target" },
      },
    );

    await expect(getPaymentContextCustomer(req)).rejects.toThrow(
      "Staff access required",
    );
  });

  it("emits a redacted ops alert for payment-method route failures", async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const req = makeReq(
      { logger },
      {
        actorId: "cus_actor",
        headers: { [STAFF_TARGET_CUSTOMER_ID_HEADER]: "cus_target" },
      },
    );

    await emitPaymentMethodRouteFailureAlert({
      req,
      fallbackMessage: "Could not start a card setup. Please try again.",
      error: new Error(
        "Stripe rejected pm_123 for avi@example.com while confirming seti_123",
      ),
      logger,
    });

    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "payment_method_route_failed",
        severity: "warn",
        title: "Payment method setup_intent failed",
        path: "src/api/store/payment-methods",
        source: "medusa-server",
        logger,
        meta: expect.objectContaining({
          operation: "setup_intent",
          actor_id: "cus_actor",
          has_staff_target_customer_id: true,
          staff_target_customer_id: "cus_target",
          error_message:
            "Stripe rejected [redacted-stripe-id] for [redacted-email] while confirming [redacted-stripe-id]",
        }),
      }),
    );
    expect(JSON.stringify((emitOpsAlert as jest.Mock).mock.calls[0][0].meta))
      .not.toContain("avi@example.com");
    expect(JSON.stringify((emitOpsAlert as jest.Mock).mock.calls[0][0].meta))
      .not.toContain("pm_123");
  });

  it("keeps the payment-method route response generic while alerting", () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const req = makeReq({ logger }, { actorId: "cus_actor" });
    const res = {
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(),
    } as any;

    handleRouteError(
      req,
      res,
      new Error("Stripe unavailable"),
      "Could not delete payment method.",
    );

    expect(logger.error).toHaveBeenCalledWith(
      "[payment-methods] Could not delete payment method.: Stripe unavailable",
    );
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "payment_method_route_failed",
        title: "Payment method delete failed",
        meta: expect.objectContaining({
          operation: "delete",
          actor_id: "cus_actor",
          has_staff_target_customer_id: false,
          staff_target_customer_id: null,
          error_message: "Stripe unavailable",
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: "Could not delete payment method.",
    });
  });
});
