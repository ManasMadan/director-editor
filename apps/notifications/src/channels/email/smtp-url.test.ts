import { describe, expect, it } from "vitest";
import { productionSmtpProblem } from "./smtp-url";

describe("productionSmtpProblem", () => {
  it("accepts authenticated submission over implicit TLS or required STARTTLS", () => {
    expect(productionSmtpProblem("smtps://no-reply:secret@mail.example.com:465")).toBeUndefined();
    expect(
      productionSmtpProblem("smtp://no-reply:secret@mail.example.com:587?requireTLS=true"),
    ).toBeUndefined();
    expect(
      productionSmtpProblem(
        "smtps://no-reply%40example.com:s%2Fcret@stalwart.mail.svc:465?tls.servername=mail.example.com",
      ),
    ).toBeUndefined();
  });

  it("refuses submission without credentials", () => {
    expect(productionSmtpProblem("smtps://mail.example.com:465")).toMatch(/credentials/);
    expect(productionSmtpProblem("smtps://no-reply@mail.example.com:465")).toMatch(/credentials/);
    expect(productionSmtpProblem("smtps://:secret@mail.example.com:465")).toMatch(/credentials/);
  });

  it("refuses anything that could send in the clear", () => {
    // Mailpit's local URL.
    expect(productionSmtpProblem("smtp://localhost:51025")).toMatch(/credentials/);
    expect(productionSmtpProblem("smtp://no-reply:secret@mail.example.com:587")).toMatch(/TLS/);
    expect(
      productionSmtpProblem("smtp://no-reply:secret@mail.example.com:587?requireTLS=false"),
    ).toMatch(/TLS/);
    expect(
      productionSmtpProblem(
        "smtp://no-reply:secret@mail.example.com:587?requireTLS=true&ignoreTLS=true",
      ),
    ).toMatch(/ignoreTLS/);
  });

  it("refuses an unchecked certificate (the local Stalwart container's setting)", () => {
    expect(
      productionSmtpProblem("smtps://no-reply:secret@localhost:51465?tls.rejectUnauthorized=false"),
    ).toMatch(/certificate/);
  });
});
