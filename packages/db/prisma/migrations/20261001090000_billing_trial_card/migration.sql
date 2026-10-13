-- One free trial per card: the cards that have had one, by Stripe's fingerprint, so a new
-- workspace paying with the same card gets no second trial. Not a tenant table (no org_id):
-- the check has to see every workspace's cards, and a row holds only Stripe's ids.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "billing"."trial_card" (
    "fingerprint" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_card_pkey" PRIMARY KEY ("fingerprint")
);

-- ---------------------------------------------------------------------------- privileges
-- Claimed once and never changed or removed: the first subscription keeps the card's trial.
GRANT SELECT, INSERT ON billing.trial_card TO app_api;
