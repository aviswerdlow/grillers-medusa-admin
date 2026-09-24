import importLegacyCustomers from "../import-legacy-customers"

describe("legacy customer B0 selector", () => {
  const originalArgv = process.argv
  const container = { resolve: () => ({}) } as any

  afterEach(() => {
    process.argv = originalArgv
  })

  it("refuses --apply with an ID list before reading files or connecting", async () => {
    process.argv = ["node", "import-legacy-customers", "--apply", "--ids-file", "/nonexistent/r1-ids.txt"]
    await expect(importLegacyCustomers({ container } as any)).rejects.toThrow(
      "--ids-file is dry-run only"
    )
  })

  it("requires sealed B0 inputs for a dry-run ID list", async () => {
    process.argv = ["node", "import-legacy-customers", "--ids-file", "/nonexistent/r1-ids.txt"]
    await expect(importLegacyCustomers({ container } as any)).rejects.toThrow(
      "--ids-file requires manifest output"
    )
  })
})
