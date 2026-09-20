import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { POST } from "../route"
import {
  LegacyReorderRequestError,
  submitLegacyReorderRequest,
} from "../../../../../lib/legacy-reorder-request"
import { emitOpsAlert } from "../../../../../lib/ops-alert"

jest.mock("../../../../../lib/legacy-reorder-request", () => {
  class LegacyReorderRequestError extends Error {
    statusCode: number
    constructor(message: string, statusCode: number) {
      super(message)
      this.statusCode = statusCode
    }
  }

  return {
    LegacyReorderRequestError,
    notificationModuleFromScope: jest.fn(() => ({ createNotifications: jest.fn() })),
    submitLegacyReorderRequest: jest.fn(),
  }
})

jest.mock("../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: any) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq() {
  const logger = { error: jest.fn() }
  return {
    gp_staff_principal: { id: "staff_1", kind: "customer", email: "ops@example.com", name: "Fixture Operator" },
    body: {
      customer_id: "cus_admin_legacy",
      key: "legacy:item",
      staff_actor_customer_id: "staff_1",
      staff_actor_email: "ops@example.com",
    },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return jest.fn()
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        return undefined
      },
    },
  } as any
}

describe("admin legacy reorder request route alerting", () => {
  beforeEach(() => {
    ;(submitLegacyReorderRequest as jest.Mock).mockReset()
    ;(emitOpsAlert as jest.Mock).mockClear()
  })

  it("returns known reorder errors without alerting", async () => {
    ;(submitLegacyReorderRequest as jest.Mock).mockRejectedValue(
      new LegacyReorderRequestError("Purchase history item not found", 404)
    )

    const res = makeRes()
    await POST(makeReq(), res)

    expect(res.statusCode).toBe(404)
    expect(emitOpsAlert).not.toHaveBeenCalled()
  })

  it("emits a page alert on unexpected staff reorder submission failures", async () => {
    ;(submitLegacyReorderRequest as jest.Mock).mockRejectedValue(
      new Error("insert failed")
    )

    const res = makeRes()
    await POST(makeReq(), res)

    expect(res.statusCode).toBe(500)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "legacy_reorder_request_failed",
        severity: "page",
        fingerprint: "legacy_reorder_request:admin:500",
        meta: expect.objectContaining({
          customer_id: "cus_admin_legacy",
          staff_actor_customer_id: "staff_1",
          source: "admin_staff_reorder",
          has_key: true,
          error_message: "insert failed",
        }),
      })
    )
  })
})
