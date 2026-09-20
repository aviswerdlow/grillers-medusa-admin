/** Reviewed shipping mass and fit inputs. SAM's pound-labelled scalar is not
 * assumed to be physical mass; neither fit units nor pricing weights go on labels. */
export const SHIPPING_WEIGHT_KEY = "shipping_weight_v1";
export const SHIPPING_WEIGHT_SNAPSHOT_KEY = "shipping_weight_snapshot_v1";
export const PHYSICAL_WEIGHT_CONTRACT = "shipping_weight_v1.physical_lb";

export type ShippingWeightRecord = {
  version: 1;
  qbd_list_id: string;
  kind: "physical" | "packaging" | "nonphysical" | "internal";
  physical_weight: number | string | null;
  physical_unit: "lb" | "oz" | null;
  physical_basis: "per_sellable_unit" | "per_inner_unit" | null;
  units_per_sellable: number | null;
  fit_units: number | string | null;
  fit_rule_id: string | null;
  raw_sam_value: string | null;
  raw_sam_unit: "lb";
  raw_sam_meaning: "physical" | "space_proxy" | "unknown";
  source_item_id: string;
  source_revision: string;
  source_captured_at: string;
  review_status: "pending" | "approved";
  approved_by: string | null;
  approved_at: string | null;
};

export type ShippingLine = {
  id?: string;
  variant_id?: string;
  variant_sku?: string;
  sku?: string;
  quantity?: unknown;
  raw_quantity?: unknown;
  metadata?: unknown;
  variant?: {
    id?: string;
    sku?: string;
    metadata?: unknown;
    product?: { metadata?: unknown };
  };
  product?: { metadata?: unknown };
};
export type ShippingWeightSnapshot = {
  version: 1;
  variant_id: string;
  quantity: number;
  captured_at: string;
  record: ShippingWeightRecord;
};
export type ResolvedShippingLine = {
  lineId: string | null;
  variantId: string;
  qbdListId: string;
  quantity: number;
  kind: ShippingWeightRecord["kind"];
  physicalWeightLb: number;
  fitUnits: number;
  fitRuleId: string | null;
  source: "snapshot" | "variant" | "product";
  record: ShippingWeightRecord;
};
export type ResolvedShippingWeights = {
  version: 1;
  physicalWeightLb: number;
  fitUnits: number;
  fitRuleId: string | null;
  lines: ResolvedShippingLine[];
};

export class ShippingInputError extends Error {
  constructor(
    readonly code: string,
    readonly lineId?: string,
  ) {
    super(
      code.startsWith("shipping_price") || code === "invalid_shipping_money"
        ? "Shipping pricing needs review. Refresh your shipping options or contact the store."
        : "Shipping needs an item-weight or packing review. Please contact the store for this shipping option.",
    );
    this.name = "ShippingInputError";
  }
}

export function shippingMetadata(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      return shippingMetadata(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
export function shippingListId(metadata: unknown): string | null {
  const m = shippingMetadata(metadata);
  for (const key of [
    "qbd_list_id",
    "quickbooks_list_id",
    "qb_list_id",
    "qbd_item_list_id",
    "quickbooks_item_list_id",
  ]) {
    if (typeof m[key] === "string" && m[key].trim()) return m[key].trim();
  }
  return null;
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
export function shippingNumber(value: unknown): number | null {
  if (value && typeof value === "object" && "value" in value)
    return shippingNumber((value as any).value);
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function quantityOf(line: ShippingLine): number {
  const q = shippingNumber(line.quantity ?? line.raw_quantity);
  if (q === null || q <= 0 || !Number.isSafeInteger(q))
    throw new ShippingInputError("invalid_sellable_quantity", line.id);
  return q;
}

export function validateShippingWeightRecord(
  value: unknown,
  listId: string,
): ShippingWeightRecord {
  const r = shippingMetadata(value) as ShippingWeightRecord;
  if (r.version !== 1 || r.qbd_list_id !== listId)
    throw new ShippingInputError("weight_identity_or_version_mismatch");
  if (!["physical", "packaging", "nonphysical", "internal"].includes(r.kind))
    throw new ShippingInputError("unknown_shipping_kind");
  if (
    !text(r.source_revision) ||
    !text(r.source_item_id) ||
    !date(r.source_captured_at) ||
    r.raw_sam_unit !== "lb" ||
    !["physical", "space_proxy", "unknown"].includes(r.raw_sam_meaning) ||
    !(r.raw_sam_value === null || typeof r.raw_sam_value === "string")
  )
    throw new ShippingInputError("missing_weight_provenance");
  if (
    r.review_status !== "approved" ||
    !text(r.approved_by) ||
    !date(r.approved_at)
  )
    throw new ShippingInputError("unreviewed_shipping_weight");
  if (r.kind === "physical") {
    const mass = shippingNumber(r.physical_weight),
      fit = shippingNumber(r.fit_units);
    if (
      mass === null ||
      mass <= 0 ||
      !["lb", "oz"].includes(r.physical_unit ?? "")
    )
      throw new ShippingInputError("missing_physical_weight_or_unit");
    if (
      !["per_sellable_unit", "per_inner_unit"].includes(r.physical_basis ?? "")
    )
      throw new ShippingInputError("invalid_physical_weight_basis");
    if (
      !Number.isSafeInteger(r.units_per_sellable) ||
      r.units_per_sellable! <= 0 ||
      (r.physical_basis === "per_sellable_unit" && r.units_per_sellable !== 1)
    )
      throw new ShippingInputError("ambiguous_multipack_weight");
    if (fit === null || fit <= 0 || !text(r.fit_rule_id))
      throw new ShippingInputError("missing_fit_allowance_or_rule");
  } else if (
    [
      r.physical_weight,
      r.physical_unit,
      r.physical_basis,
      r.units_per_sellable,
      r.fit_units,
      r.fit_rule_id,
    ].some((v) => v !== null)
  ) {
    throw new ShippingInputError("nonphysical_record_contains_mass");
  }
  return JSON.parse(JSON.stringify(r));
}

/** Cart metadata is customer-editable. Only a caller that loaded a persisted
 * order may opt into line-snapshot precedence; cart quotes always use catalog data. */
export function resolveShippingLine(
  line: ShippingLine,
  options: { persistedOrder?: boolean } = {},
): ResolvedShippingLine {
  const quantity = quantityOf(line),
    variantId = line.variant_id || line.variant?.id;
  if (!text(variantId))
    throw new ShippingInputError("missing_variant_identity", line.id);
  const lineMeta = shippingMetadata(line.metadata),
    variantMeta = shippingMetadata(line.variant?.metadata);
  const productMeta = shippingMetadata(
    line.variant?.product?.metadata ?? line.product?.metadata,
  );
  const sku = line.variant?.sku ?? line.variant_sku ?? line.sku ?? "";
  let source: ResolvedShippingLine["source"],
    raw: unknown,
    listId: string | null;
  const snapshot = lineMeta[SHIPPING_WEIGHT_SNAPSHOT_KEY] as
    | ShippingWeightSnapshot
    | undefined;
  if (options.persistedOrder && snapshot !== undefined) {
    if (
      snapshot.version !== 1 ||
      snapshot.variant_id !== variantId ||
      snapshot.quantity !== quantity ||
      !date(snapshot.captured_at)
    )
      throw new ShippingInputError("stale_shipping_snapshot", line.id);
    source = "snapshot";
    raw = snapshot.record;
    listId = snapshot.record?.qbd_list_id;
  } else {
    if (
      /^RM-/i.test(sku) ||
      [
        variantMeta.availability_lifecycle,
        productMeta.availability_lifecycle,
      ].includes("internal_only")
    )
      throw new ShippingInputError("internal_shipping_line", line.id);
    listId = shippingListId(variantMeta) ?? shippingListId(productMeta);
    if (
      Object.prototype.hasOwnProperty.call(variantMeta, SHIPPING_WEIGHT_KEY)
    ) {
      source = "variant";
      raw = variantMeta[SHIPPING_WEIGHT_KEY];
    } else {
      source = "product";
      raw = productMeta[SHIPPING_WEIGHT_KEY];
    }
  }
  if (!listId) throw new ShippingInputError("missing_qbd_identity", line.id);
  if (!raw) throw new ShippingInputError("missing_shipping_weight", line.id);
  const record = validateShippingWeightRecord(raw, listId);
  if (record.kind === "internal")
    throw new ShippingInputError("internal_shipping_line", line.id);
  const physicalWeightLb =
    record.kind === "physical"
      ? (Number(record.physical_weight) /
          (record.physical_unit === "oz" ? 16 : 1)) *
        record.units_per_sellable! *
        quantity
      : 0;
  const fitUnits =
    record.kind === "physical" ? Number(record.fit_units) * quantity : 0;
  if (!Number.isFinite(physicalWeightLb) || !Number.isFinite(fitUnits))
    throw new ShippingInputError("shipping_weight_overflow", line.id);
  return {
    lineId: line.id ?? null,
    variantId,
    qbdListId: listId,
    quantity,
    kind: record.kind,
    physicalWeightLb,
    fitUnits,
    fitRuleId: record.fit_rule_id,
    source,
    record,
  };
}

export function resolveShippingWeights(
  lines: ShippingLine[],
  options: { persistedOrder?: boolean } = {},
): ResolvedShippingWeights {
  if (!lines.length) throw new ShippingInputError("no_shipping_lines");
  const resolved = lines.map((line) => resolveShippingLine(line, options));
  const physical = resolved.filter((line) => line.kind === "physical");
  const rules = new Set(physical.map((line) => line.fitRuleId));
  if (rules.size > 1) throw new ShippingInputError("conflicting_fit_rules");
  return {
    version: 1,
    lines: resolved,
    physicalWeightLb: physical.reduce((s, l) => s + l.physicalWeightLb, 0),
    fitUnits: physical.reduce((s, l) => s + l.fitUnits, 0),
    fitRuleId: physical[0]?.fitRuleId ?? null,
  };
}

/** Called for cart lines at the server's acceptance boundary, never with
 * request-body catalog metadata. Never call this to refresh a persisted order. */
export function shippingWeightSnapshots(
  lines: ShippingLine[],
  capturedAt: string,
): Array<{ id: string; metadata: Record<string, any> }> {
  if (!date(capturedAt)) throw new ShippingInputError("invalid_snapshot_time");
  return lines.map((line) => {
    if (!text(line.id)) throw new ShippingInputError("missing_line_identity");
    const resolved = resolveShippingLine(line);
    const metadata = { ...shippingMetadata(line.metadata) };
    metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY] = {
      version: 1,
      variant_id: resolved.variantId,
      quantity: resolved.quantity,
      captured_at: capturedAt,
      record: resolved.record,
    } satisfies ShippingWeightSnapshot;
    return { id: line.id, metadata };
  });
}
