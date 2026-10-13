import { Module } from "@nestjs/common";
import { required } from "@repo/contracts/objects";
import { env } from "../../env";
import { SmtpTransport } from "../email/email-transport";
import { EmailSinkSmsTransport } from "./email-sink";
import { SmsChannel } from "./sms.channel";
import { SMS_TRANSPORT, type SmsTransport } from "./sms-transport";
import { TwilioTransport } from "./twilio";

function createTransport(): SmsTransport | null {
  switch (env.SMS_PROVIDER) {
    case "twilio":
      // Presence is checked at boot in env.ts.
      return new TwilioTransport({
        accountSid: required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID"),
        authToken: required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN"),
        from: required(env.TWILIO_FROM, "TWILIO_FROM"),
        apiUrl: env.TWILIO_API_URL,
      });
    case "email":
      return new EmailSinkSmsTransport(new SmtpTransport(env.SMTP_URL), env.EMAIL_FROM);
    case undefined:
      return null;
  }
}

@Module({
  providers: [{ provide: SMS_TRANSPORT, useFactory: createTransport }, SmsChannel],
  exports: [SmsChannel],
})
export class SmsModule {}
