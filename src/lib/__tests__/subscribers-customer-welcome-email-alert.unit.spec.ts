import customerWelcomeEmailHandler from "../../subscribers/customer-welcome-email"

it("retires the delayed welcome writer without customer reads, sends or production alerts", async () => {
  const container = {
    resolve: jest.fn(() => {
      throw new Error("Retired path must not resolve dependencies")
    }),
  }
  await customerWelcomeEmailHandler({
    event: { data: { id: "cus_legacy" } },
    container,
  } as any)
  expect(container.resolve).not.toHaveBeenCalled()
})
