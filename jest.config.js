const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
          target: "es2022",
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

if (process.env.TEST_TYPE === "integration:catalog") {
  module.exports.testMatch = ["**/integration-tests/catalog/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:contacts") {
  module.exports.testMatch = ["**/integration-tests/contacts/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:receipt-email") {
  module.exports.testMatch = ["**/integration-tests/receipt-email/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:accounting") {
  module.exports.testMatch = ["**/integration-tests/accounting/*.spec.[jt]s"];
}

if (process.env.TEST_TYPE === "integration:incoming-stock") {
  module.exports.testMatch = ["**/integration-tests/incoming-stock/*.spec.[jt]s"];
}
