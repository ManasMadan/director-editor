-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "billing";

-- CreateTable
CREATE TABLE "billing"."customer" (
    "org_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "billing"."subscription" (
    "id" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "price_id" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "current_period_end" TIMESTAMPTZ(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_end" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_stripe_customer_id_key" ON "billing"."customer"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "subscription_org_id_idx" ON "billing"."subscription"("org_id");

-- AddForeignKey
ALTER TABLE "billing"."customer" ADD CONSTRAINT "customer_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."subscription" ADD CONSTRAINT "subscription_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
ALTER TABLE billing.customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.customer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.customer
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE billing.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.subscription
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------- privileges

GRANT USAGE ON SCHEMA billing TO app_api;
GRANT SELECT, INSERT ON billing.customer TO app_api;
GRANT SELECT, INSERT, UPDATE ON billing.subscription TO app_api;
