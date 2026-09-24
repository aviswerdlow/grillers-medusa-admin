import { GET } from "../admin/grillers/analytics/order-promises/route";
import { parseOrderPromiseReadQuery, readOrderPromisePage } from "../../lib/order-promise-reader";
import { OrderPromiseError } from "../../lib/order-promise";

jest.mock("../../lib/order-promise-reader", () => ({
  ...jest.requireActual("../../lib/order-promise-reader"), readOrderPromisePage: jest.fn(),
}));
const read = readOrderPromisePage as jest.Mock;
const query = { start: "2026-09-01T04:00:00Z", end: "2026-09-20T04:00:00Z" };
const now = new Date("2026-09-20T10:00:00Z");
function response() { const res: any = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; }
beforeEach(() => jest.clearAllMocks());

it.each([
  {}, { ...query, email: "not-allowed@example.invalid" }, { ...query, limit: "101" },
  { ...query, offset: "1" }, { ...query, offset: "-1" }, { ...query, revision: "bad" },
  { ...query, start: query.end }, { ...query, start: "2026-07-01T00:00:00Z" },
  { ...query, end: "2026-09-21T00:00:00Z" }, { ...query, start: "not a date" },
])("rejects unbounded, mutable-field or invalid original queries", bad => {
  expect(() => parseOrderPromiseReadQuery(bad, now)).toThrow(OrderPromiseError);
});
it("normalizes UTC bounds and requires a revision for later pages", () => {
  expect(parseOrderPromiseReadQuery(query, now)).toMatchObject({ start: "2026-09-01T04:00:00.000Z", limit: 100, offset: 0 });
  expect(parseOrderPromiseReadQuery({ ...query, offset: "100", revision: "a".repeat(64) }, now).offset).toBe(100);
});
it.each([undefined, { kind: "customer" }, { kind: "operator" }, { kind: "service" }])("requires the dedicated reader even on direct handler invocation", async principal => {
  const resolve = jest.fn(), res = response();
  await GET({ gp_staff_principal: principal, scope: { resolve } } as any, res);
  expect(res.status).toHaveBeenCalledWith(403); expect(resolve).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("returns only the verified reader result and disables response caching", async () => {
  const body = { orders: [], count: 0 }; read.mockResolvedValue(body);
  const res = response();
  await GET({ gp_staff_principal: { kind: "service", service_scope: "parity" }, query, scope: { resolve: () => "fixture-db" } } as any, res);
  expect(read).toHaveBeenCalledWith("fixture-db", query);
  expect(res.json).toHaveBeenCalledWith(body); expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
it.each([new Error("private SQL and email@example.invalid"), new OrderPromiseError("order_promise_original_unavailable", 503)])("returns bounded unavailable codes without underlying errors", async error => {
  read.mockRejectedValue(error); const res = response();
  await GET({ gp_staff_principal: { kind: "service", service_scope: "parity" }, query, scope: { resolve: () => ({}) } } as any, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/private|email@example/);
});
