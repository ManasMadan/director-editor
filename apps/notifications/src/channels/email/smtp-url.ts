/**
 * What production requires of SMTP_URL: authenticated submission over TLS with the
 * server's certificate checked, e.g. smtps://no-reply%40example.com:<password>@mail.example.com
 * (implicit TLS, port 465) or smtp://…:587?requireTLS=true (STARTTLS). Nodemailer reads
 * its options from the query; `tls.servername=<name>` checks the certificate against the
 * mail server's public name when connecting to it by a cluster-internal one.
 *
 * Locally, Mailpit takes plain unauthenticated SMTP and the Stalwart container a
 * self-signed certificate (`tls.rejectUnauthorized=false`); both are refused here.
 */
export function productionSmtpProblem(value: string): string | undefined {
  const url = new URL(value);
  const query = url.searchParams;
  if (!url.username || !url.password) {
    return "needs the submission account's credentials";
  }
  // Without requireTLS, nodemailer sends in the clear when the server doesn't offer STARTTLS.
  if (url.protocol !== "smtps:" && query.get("requireTLS") !== "true") {
    return "must use TLS: smtps:// (implicit TLS) or smtp:// with requireTLS=true (STARTTLS)";
  }
  if (query.get("ignoreTLS") === "true") {
    return "must not set ignoreTLS";
  }
  if (query.get("tls.rejectUnauthorized") === "false") {
    return "must verify the server's certificate (no tls.rejectUnauthorized=false)";
  }
  return undefined;
}
