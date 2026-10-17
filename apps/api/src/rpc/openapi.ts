/**
 * The REST API's OpenAPI 3.1 document, generated from the contract. The server serves it
 * at /api/v1/openapi.json; `bun run gen` also writes it to apps/api/openapi.json, so a
 * pull request shows every change to the public API as a diff and CI can refuse the
 * breaking ones (oasdiff, in ci.yml).
 */
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract, errorData } from "@repo/contracts/api";
import * as z from "zod";

export async function openApiDocument({
  version,
  serverUrl,
}: {
  version: string;
  serverUrl: string;
}) {
  const converter = new ZodToJsonSchemaConverter();
  const spec = await new OpenAPIGenerator({ schemaConverters: [converter] }).generate(contract, {
    // One definition every error response refers to, not a copy per status per operation.
    commonSchemas: { ErrorData: { schema: errorData } },
    info: { title: "Director API", version },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    // Every operation takes a signed-in session.
    security: [{ session: [] }],
  });
  dropBodiesNeverSent(spec);
  return spec;
}

/**
 * A schema no value matches. oRPC writes a procedure that answers nothing (`z.void()`)
 * as `{ anyOf: [{ not: {} }, { not: {} }] }`, and still documents it as a JSON body.
 */
const nothing: z.ZodType = z.lazy(() =>
  z.union([z.object({ not: z.strictObject({}) }), z.object({ anyOf: z.array(nothing).min(1) })]),
);

/** An OpenAPI path item's key for each method. */
const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

/**
 * Drops the JSON body documented for a response that has none: the API answers those
 * with no body and no content type, so a client generated from the document would try
 * to parse JSON that never comes.
 */
export function dropBodiesNeverSent(spec: Spec) {
  const operations = Object.values(spec.paths ?? {}).flatMap((item) =>
    METHODS.map((method) => item?.[method]),
  );
  for (const operation of operations) {
    for (const response of Object.values(operation?.responses ?? {})) {
      if (!("content" in response)) {
        continue;
      }
      if (nothing.safeParse(response.content?.["application/json"]?.schema).success) {
        delete response.content;
      }
    }
  }
}

type Spec = Awaited<ReturnType<OpenAPIGenerator["generate"]>>;
