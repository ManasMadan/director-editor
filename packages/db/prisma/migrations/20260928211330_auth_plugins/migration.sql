-- AlterTable
ALTER TABLE "auth"."session" ADD COLUMN     "active_organization_id" UUID,
ADD COLUMN     "impersonated_by" UUID;

-- AlterTable
ALTER TABLE "auth"."user" ADD COLUMN     "ban_expires" TIMESTAMPTZ(3),
ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "banned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "auth"."two_factor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."passkey" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT,
    "public_key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."organization" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."member" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."invitation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "inviter_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."api_key" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "config_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "reference_id" UUID NOT NULL,
    "refill_interval" INTEGER,
    "refill_amount" INTEGER,
    "last_refill_at" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rate_limit_enabled" BOOLEAN NOT NULL DEFAULT true,
    "rate_limit_time_window" INTEGER NOT NULL DEFAULT 86400000,
    "rate_limit_max" INTEGER NOT NULL DEFAULT 10,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER,
    "last_request" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "permissions" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "two_factor_user_id_idx" ON "auth"."two_factor"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "passkey_credential_id_key" ON "auth"."passkey"("credential_id");

-- CreateIndex
CREATE INDEX "passkey_user_id_idx" ON "auth"."passkey"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "auth"."organization"("slug");

-- CreateIndex
CREATE INDEX "member_user_id_idx" ON "auth"."member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_organization_id_user_id_key" ON "auth"."member"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "invitation_organization_id_idx" ON "auth"."invitation"("organization_id");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "auth"."invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_key" ON "auth"."api_key"("key");

-- CreateIndex
CREATE INDEX "api_key_reference_id_idx" ON "auth"."api_key"("reference_id");

-- AddForeignKey
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."passkey" ADD CONSTRAINT "passkey_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
