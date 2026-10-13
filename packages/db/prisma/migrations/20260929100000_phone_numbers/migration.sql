-- A verified phone number per account, for texted codes and security alerts. It's only
-- written after the user proves they receive texts at it, so its presence means verified.
ALTER TABLE "auth"."user" ADD COLUMN "phone_number" TEXT;
CREATE UNIQUE INDEX "user_phone_number_key" ON "auth"."user"("phone_number");
ALTER TABLE "auth"."user"
  ADD CONSTRAINT user_phone_number_e164 CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');
