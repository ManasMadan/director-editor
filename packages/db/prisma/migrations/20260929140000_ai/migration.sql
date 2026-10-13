-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ai";

-- CreateTable
CREATE TABLE "ai"."document" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "created_by" UUID,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."chunk" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "document_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."usage" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_org_id_created_at_idx" ON "ai"."document"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "chunk_org_id_idx" ON "ai"."chunk"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_document_id_ordinal_key" ON "ai"."chunk"("document_id", "ordinal");

-- CreateIndex
CREATE INDEX "usage_org_id_created_at_idx" ON "ai"."usage"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai"."document" ADD CONSTRAINT "document_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."document" ADD CONSTRAINT "document_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."chunk" ADD CONSTRAINT "chunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ai"."document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."usage" ADD CONSTRAINT "usage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Nearest-neighbour search over embeddings (cosine distance), which Prisma can't express.
CREATE INDEX chunk_embedding_idx ON ai.chunk USING hnsw (embedding vector_cosine_ops);

ALTER TABLE ai.document
  ADD CONSTRAINT document_status_check CHECK (status IN ('pending', 'indexing', 'ready', 'failed'));

-- ---------------------------------------------------------------------------- tenancy
-- Every role sees only the organization in app.org_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document', 'chunk', 'usage'] LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON ai.%I
         USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------- privileges
-- apps/ai owns this schema's data; apps/api reaches it only through that service.
GRANT USAGE ON SCHEMA ai TO app_ai;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.document, ai.chunk TO app_ai;
GRANT SELECT, INSERT ON ai.usage TO app_ai;
