import { defineRouteConfig } from "@medusajs/admin-sdk"
import { DocumentText } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Text,
} from "@medusajs/ui"
import { FormEvent, useEffect, useMemo, useState } from "react"

type LegacyOrderLine = {
  id: string
  qbd_item_list_id: string | null
  sku: string | null
  title: string | null
  description: string | null
  quantity: number
  unit_price: number
  line_total: number
  medusa_variant_id: string | null
  mapping_status: string | null
  metadata?: {
    line_kind?: string
    mapping_source?: string
  } | null
}

type LegacyOrder = {
  id: string
  ref_number: string | null
  qbd_txn_id: string | null
  customer_name: string | null
  email_lower: string | null
  placed_at: string | null
  status: string | null
  total: number
  line_count: number
  lines: LegacyOrderLine[]
}

type LegacyOrderListResponse = {
  orders: LegacyOrder[]
  count: number
  limit: number
  offset: number
}

function formatDate(value: string | null) {
  if (!value) {
    return "Unknown"
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0)
}

function lineKind(line: LegacyOrderLine) {
  return line.metadata?.line_kind || (line.mapping_status === "non_product" ? "non-product" : "product")
}

function mappingBadgeColor(line: LegacyOrderLine) {
  if (line.medusa_variant_id) return "green" as const
  if (line.mapping_status === "non_product") return "grey" as const
  return "orange" as const
}

const LegacyOrdersPage = () => {
  const [query, setQuery] = useState("")
  const [orders, setOrders] = useState<LegacyOrder[]>([])
  const [count, setCount] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<LegacyOrder | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedPreview = useMemo(
    () => orders.find((order) => order.id === selectedId) ?? null,
    [orders, selectedId]
  )

  async function fetchOrders(search: string) {
    setIsLoading(true)
    setError(null)

    const params = new URLSearchParams({ limit: "25", offset: "0" })
    if (search.trim()) {
      params.set("q", search.trim())
    }

    try {
      const response = await fetch(`/admin/legacy-orders?${params}`, {
        credentials: "include",
      })
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
      }
      const data = (await response.json()) as LegacyOrderListResponse
      setOrders(data.orders ?? [])
      setCount(data.count ?? 0)
      setSelectedId((current) => {
        if (current && data.orders?.some((order) => order.id === current)) {
          return current
        }
        return data.orders?.[0]?.id ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  async function fetchOrder(id: string | null) {
    if (!id) {
      setSelectedOrder(null)
      return
    }

    try {
      const response = await fetch(`/admin/legacy-orders/${id}`, {
        credentials: "include",
      })
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
      }
      const data = (await response.json()) as { order: LegacyOrder }
      setSelectedOrder(data.order)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void fetchOrders("")
  }, [])

  useEffect(() => {
    void fetchOrder(selectedId)
  }, [selectedId])

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void fetchOrders(query)
  }

  const detailOrder = selectedOrder ?? selectedPreview

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <Heading>Historical Orders</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Search QuickBooks-backed order history by customer, invoice, SKU, or item.
          </Text>
        </div>
        <Badge color="grey">{count} orders</Badge>
      </div>

      <form className="flex items-center gap-2 px-6 py-4" onSubmit={onSubmit}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Customer, invoice, email, SKU, item..."
        />
        <Button isLoading={isLoading} type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {error && (
        <div className="px-6 py-3">
          <Text className="text-ui-fg-error" size="small">
            {error}
          </Text>
        </div>
      )}

      <div className="grid min-h-[560px] grid-cols-[minmax(0,1fr)_420px]">
        <div className="border-r">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Invoice</Table.HeaderCell>
                <Table.HeaderCell>Customer</Table.HeaderCell>
                <Table.HeaderCell>Date</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Total</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {orders.map((order) => (
                <Table.Row
                  className="cursor-pointer"
                  key={order.id}
                  onClick={() => setSelectedId(order.id)}
                >
                  <Table.Cell>
                    <div className="flex flex-col">
                      <Text weight="plus">
                        {order.ref_number || order.qbd_txn_id || order.id}
                      </Text>
                      <Text className="text-ui-fg-subtle" size="small">
                        {order.line_count} lines
                      </Text>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-col">
                      <Text>{order.customer_name || "Unknown customer"}</Text>
                      {order.email_lower && (
                        <Text className="text-ui-fg-subtle" size="small">
                          {order.email_lower}
                        </Text>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>{formatDate(order.placed_at)}</Table.Cell>
                  <Table.Cell className="text-right">
                    {formatMoney(order.total)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>

        <aside className="flex flex-col">
          {detailOrder ? (
            <>
              <div className="border-b px-6 py-4">
                <Text className="text-ui-fg-subtle" size="small">
                  Invoice
                </Text>
                <Heading level="h2">
                  {detailOrder.ref_number || detailOrder.qbd_txn_id || detailOrder.id}
                </Heading>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <Text className="text-ui-fg-subtle" size="small">
                      Customer
                    </Text>
                    <Text>{detailOrder.customer_name || "Unknown"}</Text>
                  </div>
                  <div>
                    <Text className="text-ui-fg-subtle" size="small">
                      Date
                    </Text>
                    <Text>{formatDate(detailOrder.placed_at)}</Text>
                  </div>
                  <div>
                    <Text className="text-ui-fg-subtle" size="small">
                      Status
                    </Text>
                    <Text>{detailOrder.status || "Imported"}</Text>
                  </div>
                  <div>
                    <Text className="text-ui-fg-subtle" size="small">
                      Total
                    </Text>
                    <Text>{formatMoney(detailOrder.total)}</Text>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-auto px-6 py-4">
                <div className="space-y-3">
                  {(selectedOrder?.lines ?? detailOrder.lines ?? []).map((line) => (
                    <div className="rounded-md border p-3" key={line.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Text weight="plus">
                            {line.title || line.description || "Untitled line"}
                          </Text>
                          {line.sku && (
                            <Text className="text-ui-fg-subtle" size="small">
                              SKU {line.sku}
                            </Text>
                          )}
                          {lineKind(line) !== "product" && (
                            <Text className="text-ui-fg-subtle" size="small">
                              Line type: {lineKind(line)}
                            </Text>
                          )}
                        </div>
                        <Badge color={mappingBadgeColor(line)}>
                          {line.mapping_status || "unmapped"}
                        </Badge>
                      </div>
                      {line.description && line.description !== line.title && (
                        <Text className="mt-2 text-ui-fg-subtle" size="small">
                          {line.description}
                        </Text>
                      )}
                      <div className="mt-3 grid grid-cols-3 gap-2 text-right">
                        <div>
                          <Text className="text-ui-fg-subtle" size="small">
                            Qty
                          </Text>
                          <Text>{line.quantity}</Text>
                        </div>
                        <div>
                          <Text className="text-ui-fg-subtle" size="small">
                            Unit
                          </Text>
                          <Text>{formatMoney(line.unit_price)}</Text>
                        </div>
                        <div>
                          <Text className="text-ui-fg-subtle" size="small">
                            Line
                          </Text>
                          <Text>{formatMoney(line.line_total)}</Text>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <Text className="text-ui-fg-subtle">
                Search for an order to inspect its historical line items.
              </Text>
            </div>
          )}
        </aside>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Historical Orders",
  icon: DocumentText,
})

export default LegacyOrdersPage
