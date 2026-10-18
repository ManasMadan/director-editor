-- The generators check's throwaway tenant table (turbo/generators/smoke/smoke-note.prisma),
-- applied only in its scratch copy. A tenant table like any other: org_id with row-level
-- security, which the generated feature's integration tests prove.
SET lock_timeout = '5s';

CREATE TABLE "app"."smoke_note" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smoke_note_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "smoke_note_org_id_fkey" FOREIGN KEY ("org_id")
      REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "smoke_note_org_id_id_idx" ON "app"."smoke_note"("org_id", "id" DESC);

ALTER TABLE app.smoke_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.smoke_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.smoke_note
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
