/**
 * Architecture boundaries, enforced in CI (`bun run lint`). Each rule's comment says
 * why it exists; changing one is an architecture decision, not a lint fix.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles make initialization order fragile (and break Nest DI at runtime).",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-app-imports-app",
      severity: "error",
      comment:
        "Deployables never import each other's code: they talk through the API contract, " +
        "queues and events. Share code through packages/ instead.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-package-imports-app",
      severity: "error",
      comment:
        "Packages are shared building blocks; an import from an app would invert the dependency.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "web-has-no-backend-code",
      severity: "error",
      comment:
        "The web app only renders. Data and logic come from the API through packages/client. " +
        "Database, queue, server framework and auth-server code must never be bundled into it. " +
        "(Test harnesses under e2e/, and the web's browser-test harness under test/, may reach the stack's services to set data up.)",
      from: {
        path: "^apps/(web|mobile)/",
        pathNot: ["^apps/(web|mobile)/e2e/", "^apps/web/test/"],
      },
      to: {
        path: [
          "^packages/(db|nest-common|jobs|logger|email)/",
          "node_modules/(@prisma|@nestjs|bullmq|ioredis|pg|nodemailer)/",
          "node_modules/better-auth/dist/(adapters|db)/",
        ],
      },
    },
    {
      name: "shared-plumbing-has-no-domain",
      severity: "error",
      comment:
        "nest-common, logger and tsdown-config are framework plumbing; domain code lives in the owning service.",
      from: { path: "^packages/(nest-common|logger|tsdown-config)/" },
      // The error-code catalog, the unit-named durations and the typed object helpers
      // (keysOf, fieldOf, required) are platform vocabulary with no domain in them, shared by
      // every layer, so they are allowed.
      to: {
        path: "^packages/(contracts|jobs|email|client)/",
        pathNot: "^packages/contracts/src/(errors|time|objects)\\.ts$",
      },
    },
    {
      name: "web-modules-only-via-barrel",
      severity: "error",
      comment:
        "A feature module is private except for its index.ts. Import another module's " +
        "public surface, or move shared code to packages/ui or packages/client.",
      from: { path: "^apps/web/src/modules/([^/]+)/" },
      to: {
        path: "^apps/web/src/modules/([^/]+)/.+",
        pathNot: ["^apps/web/src/modules/$1/", "^apps/web/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "api-modules-only-via-barrel",
      severity: "error",
      comment:
        "Nest feature modules expose their module class and public services only through index.ts.",
      from: { path: "^apps/([^/]+)/src/modules/([^/]+)/" },
      to: {
        path: "^apps/[^/]+/src/modules/([^/]+)/.+",
        pathNot: ["^apps/$1/src/modules/$2/", "^apps/[^/]+/src/modules/[^/]+/index\\.ts$"],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "generated/",
        "\\.gen\\.ts$",
        "/dist/",
        "/\\.next/",
        "/\\.venv/",
        "/storybook-static/",
        // What test runs write: reports with their own scripts, rewritten while lint reads.
        "/coverage/",
        "/playwright-report/",
        "/test-results/",
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
    },
  },
};
