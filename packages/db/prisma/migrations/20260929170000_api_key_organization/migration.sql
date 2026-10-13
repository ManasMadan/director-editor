-- API keys now belong to an organization (the api-key plugin's `references:
-- "organization"`), and go with it when it's deleted. Keys made under the old per-user
-- setting were never accepted by the API, so any left are removed rather than kept
-- pointing at a user.
DELETE FROM "auth"."api_key"
WHERE "reference_id" NOT IN (SELECT "id" FROM "auth"."organization");

ALTER TABLE "auth"."api_key" ADD CONSTRAINT "api_key_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "auth"."organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
