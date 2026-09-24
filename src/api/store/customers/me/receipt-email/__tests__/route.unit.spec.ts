import { GET, POST } from "../route";
import {
  getReceiptEmailState,
  requestReceiptEmail,
  verifyReceiptEmail,
  ReceiptEmailError,
} from "../../../../../../lib/receipt-email";
import { sendTrackedEmail } from "../../../../../../lib/communications/core";
jest.mock("../../../../../../lib/receipt-email", () => ({
  ...jest.requireActual("../../../../../../lib/receipt-email"),
  getReceiptEmailState: jest.fn(),
  requestReceiptEmail: jest.fn(),
  verifyReceiptEmail: jest.fn(),
  revokeReceiptEmail: jest.fn(),
}));
jest.mock("../../../../../../lib/communications/core", () => ({
  sendTrackedEmail: jest.fn(),
}));
const receipt = {
  revision: 1,
  active_email: "login@example.invalid",
  pending: {
    id: "challenge",
    email: "receipt@example.invalid",
    status: "pending",
  },
};
function harness(
  actor: any = { actor_id: "cus_owner", actor_type: "customer" }
) {
  const update = jest.fn(async () => 1),
    chain: any = {};
  chain.where = () => chain;
  chain.update = update;
  const db = jest.fn(() => chain),
    req: any = {
      auth_context: actor,
      body: {
        action: "request",
        email: "receipt@example.invalid",
        request_id: "synthetic-request-0001",
        expected_revision: 0,
        customer_id: "cus_victim",
      },
      scope: { resolve: () => db },
    };
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return { req, res, db, update };
}
beforeEach(() => {
  jest.clearAllMocks();
  (getReceiptEmailState as jest.Mock).mockResolvedValue(receipt);
  (requestReceiptEmail as jest.Mock).mockResolvedValue({
    challenge: null,
    replayed: true,
  });
  (sendTrackedEmail as jest.Mock).mockResolvedValue({
    ok: true,
    messageId: "synthetic",
  });
});
it.each([null, { actor_id: "staff", actor_type: "user" }])(
  "rejects noncustomer ownership",
  async (actor) => {
    const h = harness(actor);
    await POST(h.req, h.res);
    expect(h.res.status).toHaveBeenCalledWith(401);
    expect(requestReceiptEmail).not.toHaveBeenCalled();
  }
);
it("derives ownership from authentication and never sends twice on replay", async () => {
  const h = harness();
  await POST(h.req, h.res);
  expect(requestReceiptEmail).toHaveBeenCalledWith(
    h.db,
    "cus_owner",
    expect.not.objectContaining({ customer_id: "cus_victim" })
  );
  expect(sendTrackedEmail).not.toHaveBeenCalled();
  expect(h.res.status).toHaveBeenCalledWith(202);
});
it("sends the service challenge but returns no code, hash or foreign account information", async () => {
  const h = harness();
  (requestReceiptEmail as jest.Mock).mockResolvedValue({
    challenge: {
      id: "challenge",
      email: "receipt@example.invalid",
      code: "1234ABCD1234ABCD",
    },
  });
  await POST(h.req, h.res);
  expect(sendTrackedEmail).toHaveBeenCalledWith(
    h.req.scope,
    expect.objectContaining({
      to: "receipt@example.invalid",
      medusa_customer_id: "cus_owner",
      purpose: "service",
      stream: "transactional",
      idempotency_key: "receipt-challenge:challenge",
    })
  );
  expect(JSON.stringify(h.res.json.mock.calls)).not.toContain("1234ABCD");
  expect(h.update).toHaveBeenCalledWith(
    expect.objectContaining({ delivery_status: "sent" })
  );
});
it("records delivery failure without exposing a provider error", async () => {
  const h = harness();
  (requestReceiptEmail as jest.Mock).mockResolvedValue({
    challenge: {
      id: "challenge",
      email: "receipt@example.invalid",
      code: "1234ABCD1234ABCD",
    },
  });
  (sendTrackedEmail as jest.Mock).mockRejectedValue(
    new Error("private provider detail")
  );
  await POST(h.req, h.res);
  expect(h.update).toHaveBeenCalledWith(
    expect.objectContaining({ delivery_status: "failed" })
  );
  expect(JSON.stringify(h.res.json.mock.calls)).not.toContain(
    "private provider"
  );
});
it("validates input before writes and handles expired proof without success", async () => {
  const h = harness();
  h.req.body.email = "bad";
  await POST(h.req, h.res);
  expect(h.res.status).toHaveBeenCalledWith(400);
  expect(requestReceiptEmail).not.toHaveBeenCalled();
  h.req.body = { action: "verify", challenge_id: "challenge", code: "expired" };
  (verifyReceiptEmail as jest.Mock).mockRejectedValue(
    new ReceiptEmailError(400, "invalid_code", "Request a new code.")
  );
  await POST(h.req, h.res);
  expect(h.res.json).toHaveBeenLastCalledWith({
    code: "invalid_code",
    message: "Request a new code.",
  });
});
it("reads only the authenticated customer's uncached state", async () => {
  const h = harness();
  await GET(h.req, h.res);
  expect(getReceiptEmailState).toHaveBeenCalledWith(h.db, "cus_owner");
  expect(h.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
