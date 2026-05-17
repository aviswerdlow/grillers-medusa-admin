import { defineMiddlewares } from "@medusajs/framework/http"
import { authenticate } from "@medusajs/medusa/utils"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/legacy-order-history/*",
      method: ["GET"],
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/admin/legacy-orders*",
      method: ["GET"],
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
  ],
})
