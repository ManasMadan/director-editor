import { Module } from "@nestjs/common";
import { env } from "../../env";
import { EmailChannel } from "./email.channel";
import { EMAIL_TRANSPORT, SmtpTransport } from "./email-transport";

@Module({
  providers: [
    { provide: EMAIL_TRANSPORT, useFactory: () => new SmtpTransport(env.SMTP_URL) },
    EmailChannel,
  ],
  exports: [EmailChannel],
})
export class EmailModule {}
