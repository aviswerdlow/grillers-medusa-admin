/** Expand these SQL-owned enums without narrowing a later migration on replay. */
export function publicationCheckSql(
  column: "kind" | "target",
  allowed: readonly string[]
) {
  if (
    !allowed.length ||
    allowed.some((value) => !/^[a-z][a-z_]*$/.test(value))
  ) {
    throw new Error("Publication migration requires explicit enum values");
  }
  const table =
    column === "kind"
      ? "gp_order_publication"
      : "gp_order_publication_delivery";
  const constraint = `${table}_${column}_check`;
  const values = allowed.map((value) => `'${value}'`).join(",");
  const candidates = allowed.map((value) => `('${value}'::text)`).join(",");
  return `do $$
declare previous_check text; already_allows boolean;
begin
  select pg_get_expr(conbin, conrelid) into previous_check from pg_constraint
    where conrelid = '${table}'::regclass and conname = '${constraint}' and contype = 'c';
  if previous_check is not null then
    execute format($query$select bool_and((%s) is true)
      from (values ${candidates}) as proposed(${column})$query$, previous_check)
      into already_allows;
    if already_allows then return; end if;
  end if;
  -- The replacement is atomic within this DO statement. Retain the previous
  -- accepted values, including kinds introduced by a newer migration.
  alter table ${table} drop constraint if exists ${constraint};
  execute format($query$alter table ${table} add constraint ${constraint}
    check ((%s) or ${column} in (${values}))$query$, coalesce(previous_check, 'false'));
end; $$;`;
}
