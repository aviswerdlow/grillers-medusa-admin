import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExecArgs } from "@medusajs/framework/types";
import {
  planSamWeightImport,
  selectWeightImportWrites,
  applyWeightImportEntries,
  weightImportHash,
  type WeightImportPlan,
} from "../lib/sam-shipping-weight-import";
import {
  parseArgs,
  getBooleanArg,
  getStringArg,
} from "./lib/legacy-import-utils";

/** Defaults to a protected dry-run artifact. No SAM connection or credential is
 * needed here; use an independently verified read-only extract and review file. */
export default async function importSamShippingWeights({
  container,
}: ExecArgs) {
  const args = parseArgs(),
    write = getBooleanArg(args, ["write"], false);
  const arg = (key: string) => getStringArg(args, [key]);
  const read = async (file: string) =>
    JSON.parse(await readFile(path.resolve(file), "utf8"));
  const output = arg("output");
  if (!output) throw new Error("--output protected directory is required");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const save = (name: string, data: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(data, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const query = container.resolve("query"),
    logger = container.resolve("logger");
  if (!write) {
    const source = arg("source"),
      reviews = arg("reviews");
    if (!source || !reviews)
      throw new Error(
        "--source SAM extract and --reviews approval manifest are required (use [] for review-only)",
      );
    const snapshot = await read(source),
      review = await read(reviews);
    if (!Array.isArray(snapshot.rows) || !Array.isArray(review))
      throw new Error("Invalid source or review file");
    const variants: any[] = [];
    for (let skip = 0; ; skip += 200) {
      const { data } = await query.graph({
        entity: "variant",
        fields: ["id", "sku", "metadata", "product.metadata"],
        pagination: { skip, take: 200 },
      });
      variants.push(...data);
      if (data.length < 200) break;
      if (skip >= 100000)
        throw new Error("Catalog pagination exceeded safe bound");
    }
    const plan = planSamWeightImport(snapshot.rows, variants, review);
    await save("plan.json", plan);
    logger.info(
      JSON.stringify({ mode: "dry_run", planId: plan.id, counts: plan.counts }),
    );
    return;
  }
  const planFile = arg("plan"),
    expected = arg("expected-plan"),
    approval = arg("operator-approval-ref");
  if (!planFile || !expected || !approval)
    throw new Error(
      "Write requires --plan, --expected-plan and an action-time --operator-approval-ref",
    );
  const plan: WeightImportPlan = await read(planFile);
  if (
    plan.version !== 1 ||
    plan.id !==
      weightImportHash({
        sourceSha256: plan.sourceSha256,
        entries: plan.entries,
      })
  )
    throw new Error("Invalid or edited dry-run plan");
  const canaryFile = arg("canary-receipt"),
    receipt = canaryFile ? await read(canaryFile) : undefined;
  const entries = selectWeightImportWrites(plan, {
    expectedPlanId: expected,
    canaryVariantId: arg("canary-id") ?? undefined,
    canaryReceipt: receipt,
  });
  const db = container.resolve("__pg_connection__");
  if (receipt) {
    const row = await db("product_variant")
      .select("metadata")
      .where({ id: receipt.variantIds[0] })
      .whereNull("deleted_at")
      .first();
    if (
      !row ||
      weightImportHash(row.metadata) !==
        weightImportHash(receipt.beforeAfter[0].after)
    )
      throw new Error("Canary has changed since verified readback; stop batch");
  }
  const result = await applyWeightImportEntries(
    db,
    plan,
    entries,
    (entry: any) =>
      save(`${entry.variantId}-prepared.json`, { ...entry, approval }),
  );
  await save("receipt.json", {
    ...result,
    approval,
    verifiedAt: new Date().toISOString(),
  });
  logger.info(
    JSON.stringify({
      mode: "write",
      planId: plan.id,
      verifiedVariants: result.variantIds.length,
    }),
  );
}
