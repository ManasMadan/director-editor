/**
 * The REST API's OpenAPI 3.1 document, generated from the contract. The server serves it
 * at /api/v1/openapi.json; `bun run gen` also writes it to apps/api/openapi.json, so a
 * pull request shows every change to the public API as a diff and CI can refuse the
 * breaking ones (oasdiff, in ci.yml).
 */
import { type HTTPMethod, type HTTPPath, isContractProcedure } from "@orpc/contract";
import { type OpenAPI, OpenAPIGenerator, toOpenAPISchema } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { API_KEY_HEADER, API_KEY_SCOPES, contract, errorData } from "@repo/contracts/api";
import { events, webhookEvents } from "@repo/contracts/events";
import { fieldOf } from "@repo/contracts/objects";
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
    info: { title: "Boilerplate API", version },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
        apiKey: { type: "apiKey", in: "header", name: API_KEY_HEADER },
      },
    },
  });
  markApiKeyOperations(spec, contract);
  dropBodiesNeverSent(spec);
  addWebhooks(spec, converter);
  return spec;
}

/**
 * A schema no value matches. oRPC writes a procedure that answers nothing (`z.void()`)
 * as `{ anyOf: [{ not: {} }, { not: {} }] }`, and still documents it as a JSON body.
 */
const nothing: z.ZodType = z.lazy(() =>
  z.union([z.object({ not: z.strictObject({}) }), z.object({ anyOf: z.array(nothing).min(1) })]),
);

/**
 * Drops the JSON body documented for a response that has none: the API answers those
 * with no body and no content type, so a client generated from the document would try
 * to parse JSON that never comes.
 */
export function dropBodiesNeverSent(spec: Spec) {
  const operations = Object.values(spec.paths ?? {}).flatMap((item) =>
    Object.values(METHODS).map((method) => item?.[method]),
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

/**
 * What an endpoint receives for each event customers can subscribe to, in the Standard
 * Webhooks shape the delivery service signs (apps/webhooks). Each body is a component,
 * so client generators give it a name.
 */
function addWebhooks(spec: Spec, converter: ZodToJsonSchemaConverter) {
  const schemas: Record<string, OpenAPI.SchemaObject> = {};
  const webhooks: Record<string, OpenAPI.PathItemObject> = {};
  for (const name of webhookEvents) {
    const body = z.object({
      type: z.literal(name),
      timestamp: z.iso.datetime({ offset: true }),
      data: events[name],
    });
    const component = `webhook.${name}`;
    schemas[component] = toOpenAPISchema(converter.convert(body, { strategy: "output" })[1]);
    webhooks[name] = {
      post: {
        operationId: component,
        summary: name,
        description:
          "Signed with the endpoint's secret: verify the webhook-id, webhook-timestamp and webhook-signature headers (Standard Webhooks) before trusting it.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: `#/components/schemas/${component}` } },
          },
        },
        responses: { "2XX": { description: "Received. Anything else is retried." } },
      },
    };
  }
  spec.components = { ...spec.components, schemas: { ...spec.components?.schemas, ...schemas } };
  spec.webhooks = webhooks;
}

type Spec = Awaited<ReturnType<OpenAPIGenerator["generate"]>>;

/** What an operation needs of its procedure: its route, and the API key scope in its meta. */
interface Operation {
  "~orpc": { route: { path?: HTTPPath; method?: HTTPMethod }; meta: unknown };
}
// oRPC types any procedure's schemas as any, so the check names only what's read here.
const isOperation = (value: unknown): value is Operation => isContractProcedure(value);

/** An OpenAPI path item's key for each method. */
const METHODS = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  HEAD: "head",
} as const satisfies Record<HTTPMethod, string>;

const apiKeyScope = z.enum(API_KEY_SCOPES).optional();

/**
 * Every operation takes a signed-in session; those whose contract names an API key scope
 * take a key with that scope too, and say so.
 */
export function markApiKeyOperations(spec: Spec, router: unknown) {
  if (isOperation(router)) {
    return markOperation(spec, router);
  }
  if (typeof router === "object" && router !== null) {
    const children: unknown[] = Object.values(router);
    for (const child of children) {
      markApiKeyOperations(spec, child);
    }
  }
}

/** One procedure's operation: its security, and its scope in the description. */
function markOperation(spec: Spec, procedure: Operation) {
  const { route, meta } = procedure["~orpc"];
  const operation =
    route.path && route.method ? spec.paths?.[route.path]?.[METHODS[route.method]] : undefined;
  if (!operation) {
    return;
  }
  const scope = apiKeyScope.parse(fieldOf(meta, "apiKeyScope"));
  operation.security = scope ? [{ session: [] }, { apiKey: [] }] : [{ session: [] }];
  if (scope) {
    const note = `API keys need the \`${scope}\` scope.`;
    operation.description = operation.description ? `${operation.description}\n\n${note}` : note;
  }
}
