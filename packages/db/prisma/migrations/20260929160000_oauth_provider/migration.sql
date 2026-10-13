-- The OAuth 2.1 authorization server for MCP clients (better-auth jwt, oauth-provider,
-- mcp and cimd plugins). Consents and tokens reference the workspace they were approved
-- for, so deleting a workspace removes its grants with the rest of its data.

-- CreateTable
CREATE TABLE "auth"."jwks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "alg" TEXT,
    "crv" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_client" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_discovery_id" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skip_consent" BOOLEAN,
    "enable_end_session" BOOLEAN,
    "subject_type" TEXT,
    "scopes" TEXT[],
    "client_credentials_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "user_id" UUID,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "software_id" TEXT,
    "software_version" TEXT,
    "software_statement" TEXT,
    "redirect_uris" TEXT[],
    "post_logout_redirect_uris" TEXT[],
    "backchannel_logout_uri" TEXT,
    "backchannel_logout_session_required" BOOLEAN,
    "token_endpoint_auth_method" TEXT,
    "application_type" TEXT,
    "jwks" TEXT,
    "jwks_uri" TEXT,
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "require_pkce" BOOLEAN,
    "dpop_bound_access_tokens" BOOLEAN DEFAULT false,
    "reference_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_resource" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_token_ttl" INTEGER,
    "refresh_token_ttl" INTEGER,
    "signing_algorithm" TEXT,
    "signing_key_id" TEXT,
    "allowed_scopes" TEXT[],
    "custom_claims" JSONB,
    "dpop_bound_access_tokens_required" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "policy_version" INTEGER DEFAULT 1,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_client_resource" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "client_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_client_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_refresh_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" UUID,
    "user_id" UUID NOT NULL,
    "reference_id" UUID,
    "authorization_code_id" TEXT,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "rotation_replay_response" TEXT,
    "rotation_replay_expires_at" TIMESTAMPTZ(3),
    "auth_time" TIMESTAMPTZ(3),
    "confirmation" JSONB,

    CONSTRAINT "oauth_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_access_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" UUID,
    "user_id" UUID,
    "reference_id" UUID,
    "authorization_code_id" TEXT,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "refresh_id" UUID,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMPTZ(3),
    "confirmation" JSONB,

    CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_consent" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "client_id" TEXT NOT NULL,
    "user_id" UUID,
    "reference_id" UUID,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "scopes" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_client_assertion" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_client_assertion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_client_id_key" ON "auth"."oauth_client"("client_id");

-- CreateIndex
CREATE INDEX "oauth_client_user_id_idx" ON "auth"."oauth_client"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_resource_identifier_key" ON "auth"."oauth_resource"("identifier");

-- CreateIndex
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "auth"."oauth_client_resource"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_resource_client_id_resource_id_key" ON "auth"."oauth_client_resource"("client_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_token_token_key" ON "auth"."oauth_refresh_token"("token");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "auth"."oauth_refresh_token"("client_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_session_id_idx" ON "auth"."oauth_refresh_token"("session_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "auth"."oauth_refresh_token"("user_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_reference_id_idx" ON "auth"."oauth_refresh_token"("reference_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "auth"."oauth_refresh_token"("authorization_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_token_key" ON "auth"."oauth_access_token"("token");

-- CreateIndex
CREATE INDEX "oauth_access_token_client_id_idx" ON "auth"."oauth_access_token"("client_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_session_id_idx" ON "auth"."oauth_access_token"("session_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_user_id_idx" ON "auth"."oauth_access_token"("user_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_reference_id_idx" ON "auth"."oauth_access_token"("reference_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "auth"."oauth_access_token"("authorization_code_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "auth"."oauth_access_token"("refresh_id");

-- CreateIndex
CREATE INDEX "oauth_consent_client_id_idx" ON "auth"."oauth_consent"("client_id");

-- CreateIndex
CREATE INDEX "oauth_consent_user_id_idx" ON "auth"."oauth_consent"("user_id");

-- CreateIndex
CREATE INDEX "oauth_consent_reference_id_idx" ON "auth"."oauth_consent"("reference_id");

-- AddForeignKey
ALTER TABLE "auth"."oauth_client" ADD CONSTRAINT "oauth_client_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "auth"."oauth_resource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "auth"."oauth_refresh_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The worker's daily cleanup also drops expired OAuth tokens and spent client
-- assertion ids.
CREATE OR REPLACE FUNCTION auth.purge_expired() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sessions bigint;
  verifications bigint;
  access_tokens bigint;
  refresh_tokens bigint;
  assertions bigint;
BEGIN
  DELETE FROM auth.session WHERE expires_at < now();
  GET DIAGNOSTICS sessions = ROW_COUNT;
  DELETE FROM auth.verification WHERE expires_at < now();
  GET DIAGNOSTICS verifications = ROW_COUNT;
  DELETE FROM auth.oauth_access_token WHERE expires_at < now();
  GET DIAGNOSTICS access_tokens = ROW_COUNT;
  DELETE FROM auth.oauth_refresh_token WHERE expires_at < now();
  GET DIAGNOSTICS refresh_tokens = ROW_COUNT;
  DELETE FROM auth.oauth_client_assertion WHERE expires_at < now();
  GET DIAGNOSTICS assertions = ROW_COUNT;
  RETURN sessions + verifications + access_tokens + refresh_tokens + assertions;
END $$;
