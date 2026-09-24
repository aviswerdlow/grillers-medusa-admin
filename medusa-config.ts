import { loadEnv, defineConfig, Modules } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

const disableRedisModules = process.env.DISABLE_REDIS_MODULES === "true";

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
    workerMode: process.env.MEDUSA_WORKER_MODE as
      | "shared"
      | "worker"
      | "server",
    redisUrl: disableRedisModules ? undefined : process.env.REDIS_URL,
  },
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      dependencies: ["query"],
      options: {
        providers: [
          // default provider
          {
            resolve: "@medusajs/medusa/fulfillment-manual",
            id: "manual",
          },
          {
            resolve: "./src/modules/fulfillment",
            id: "grillers-fulfillment",
            options: {},
          },
        ],
      },
    },
    ...(!disableRedisModules
      ? [
          {
            resolve: "@medusajs/medusa/cache-redis",
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
          {
            resolve: "@medusajs/medusa/event-bus-redis",
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
          {
            resolve: "@medusajs/medusa/workflow-engine-redis",
            options: {
              redis: {
                url: process.env.REDIS_URL,
              },
            },
          },
          {
            resolve: "@medusajs/medusa/locking",
            options: {
              providers: [
                {
                  resolve: "@medusajs/medusa/locking-redis",
                  id: "locking-redis",
                  is_default: true,
                  options: {
                    redisUrl: process.env.REDIS_URL,
                  },
                },
              ],
            },
          },
        ]
      : []),
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-s3",
            id: "s3",
            options: {
              file_url: process.env.S3_FILE_URL,
              access_key_id: process.env.S3_ACCESS_KEY_ID,
              secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
              region: process.env.S3_REGION,
              bucket: process.env.S3_BUCKET,
              endpoint: process.env.S3_ENDPOINT,
              additional_client_config: {
                forcePathStyle: true,
              },
            },
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/notification",
      options: {
        providers: [
          {
            resolve: "./src/modules/notification-postmark",
            id: "postmark",
            options: {
              channels: ["email"],
              api_token: process.env.POSTMARK_API_TOKEN,
              from: process.env.POSTMARK_FROM,
              transactional_stream:
                process.env.POSTMARK_TRANSACTIONAL_STREAM || "outbound",
              lifecycle_stream:
                process.env.POSTMARK_LIFECYCLE_STREAM || "broadcast",
              broadcast_stream:
                process.env.POSTMARK_BROADCAST_STREAM || "broadcast",
            },
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/payment-stripe",
            id: "stripe",
            options: {
              apiKey: process.env.STRIPE_API_KEY,
              webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
            },
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/tax",
      options: {
        providers: [
          {
            resolve: "./src/modules/ga-tax",
            id: "ga-tax",
          },
        ],
      },
    },
    {
      resolve: "./src/modules/strapi",
      options: {
        strapiUrl: process.env.STRAPI_URL,
        strapiToken: process.env.STRAPI_TOKEN,
      },
    },
    {
      resolve: "./src/modules/legacy-order-history",
    },
    {
      resolve: "./src/modules/gp-inventory-allocation",
    },
    {
      resolve: "./src/modules/gp-institutional-credit",
    },
    {
      resolve: "./src/modules/gp-catch-weight",
    },
    {
      resolve: "./src/modules/gp-communications",
    },
    {
      resolve: "@medusajs/medusa/analytics",
      options: {
        providers: [
          {
            resolve: "./src/modules/gp-analytics",
            id: "gp-analytics",
            options: {
              jitsuHost: process.env.JITSU_HOST,
              jitsuServerSecret: process.env.JITSU_SERVER_SECRET,
              gpAnalyticsEndpoint: process.env.GP_ANALYTICS_ENDPOINT,
              gpAnalyticsServerKey: process.env.GP_ANALYTICS_SERVER_KEY,
              gpAnalyticsDualRun:
                process.env.GP_ANALYTICS_DUAL_RUN !== "false",
            },
          },
        ],
      },
    },
  ],
  admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN === "true",
    backendUrl: process.env.MEDUSA_BACKEND_URL,
  },
});
