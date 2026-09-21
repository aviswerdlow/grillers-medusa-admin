import { createHmac } from "node:crypto";
import { POST } from "../route";
import { queueRefundNotification } from "../../../../../lib/refund-provider";
jest.mock("../../../../../lib/refund-provider", () => ({
  queueRefundNotification: jest.fn(),
}));
const queue = queueRefundNotification as jest.Mock;
const saved = { ...process.env };
beforeEach(() => {
  process.env.GP_REFUND_RECONCILIATION_ENABLED = "true";
  process.env.STRIPE_REFUND_WEBHOOK_SECRET = "whsec_synthetic";
  process.env.GP_REFUND_STRIPE_READ_KEY = "rk_test_synthetic";
  process.env.GP_REFUND_STRIPE_ACCOUNT_ID = "acct_test";
  process.env.GP_ORDER_PUBLICATION_START_AT = "2026-09-20T00:00:00Z";
  queue.mockReset().mockResolvedValue("queued");
});
afterEach(() => {
  process.env = { ...saved };
});
async function request(raw = '{"id":"evt_signed"}', signature = true) {
  const t = Math.floor(Date.now() / 1000);
  const h = createHmac("sha256", "whsec_synthetic")
    .update(`${t}.${raw}`)
    .digest("hex");
  const req: any = {
    rawBody: Buffer.from(raw),
    body: { id: "evt_unsigned" },
    headers: { "stripe-signature": signature ? `t=${t},v1=${h}` : "bad" },
    scope: { resolve: jest.fn(() => "db") },
  };
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  await POST(req, res);
  return { req, res };
}
it("uses verified raw bytes, never unsigned parsed body", async () => {
  const { res } = await request();
  expect(queue).toHaveBeenCalledWith(
    "db",
    expect.objectContaining({ livemode: false }),
    { id: "evt_signed" }
  );
  expect(res.status).toHaveBeenCalledWith(200);
});
it("rejects bad signatures before resolving any database or queue", async () => {
  const { req, res } = await request(undefined, false);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(req.scope.resolve).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
});
it("rejects signed invalid JSON", async () => {
  const { res } = await request("broken");
  expect(res.status).toHaveBeenCalledWith(400);
  expect(queue).not.toHaveBeenCalled();
});
it("does not acknowledge unavailable durable storage", async () => {
  queue.mockRejectedValue(new Error("private sql"));
  const { res } = await request();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain("private");
});
it("stays disabled until coordinated activation", async () => {
  delete process.env.GP_REFUND_RECONCILIATION_ENABLED;
  const { res } = await request();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(queue).not.toHaveBeenCalled();
});
