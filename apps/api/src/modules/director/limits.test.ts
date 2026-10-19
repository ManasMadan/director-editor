/**
 * Director's contract matches the Python service's models (the schemas generated from
 * apps/ai's Pydantic models): the input limits, so a request the API accepts is never one
 * the service refuses, and the plan's shape, so every plan the service returns parses
 * here, field for field and value for value.
 */
import {
  zBrainstormRequest,
  zClipRequest,
  zEditorRequest,
  zLocated,
  zLocateRequest,
  zMatchCutRequest,
  zReviseRequest,
  zShotPlan,
} from "@repo/ai-client/schemas";
import {
  contract,
  DIRECTOR_FRAME_MAX_LENGTH,
  DIRECTOR_FRAME_MIN_LENGTH,
  DIRECTOR_LOCATE_TARGET_MAX_LENGTH,
  DIRECTOR_MARK_LABEL_MAX_LENGTH,
  DIRECTOR_MAX_SHOTS,
  locatedSchema,
  shotPlanSchema,
} from "@repo/contracts/api";
import {
  RECORDING_MAX_SLICES_PER_PART,
  RECORDING_PART_MAX_MS,
  RECORDING_SLICE_MAX_MS,
  RECORDING_TYPES,
} from "@repo/contracts/recording";
import { describe, expect, it } from "vitest";
import * as z from "zod";

const node = z.looseObject({
  type: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  maxLength: z.number().optional(),
  minLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
});
type Node = z.infer<typeof node>;

/** Each field's path in a JSON Schema, with the values an enum allows. */
function shape(schema: unknown, at = ""): Record<string, string> {
  const parsed = node.safeParse(schema);
  if (!parsed.success) {
    return {};
  }
  const { properties, items, anyOf, oneOf } = parsed.data;
  const found: Record<string, string> = parsed.data.enum
    ? { [at]: parsed.data.enum.join("|") }
    : {};
  for (const [name, child] of Object.entries(properties ?? {})) {
    Object.assign(found, { [`${at}.${name}`]: "field" }, shape(child, `${at}.${name}`));
  }
  if (items) {
    Object.assign(found, shape(items, `${at}[]`));
  }
  for (const option of [...(anyOf ?? []), ...(oneOf ?? [])]) {
    Object.assign(found, shape(option, at));
  }
  return found;
}

/**
 * A node's own limits. An integer's exclusive bound is written as the inclusive one it
 * means (Pydantic's `lt=12` is zod's `.max(11)`), and an enum's values in order.
 */
function boundsOf(schema: Node): Record<string, number | string> {
  const integer = schema.type === "integer";
  const bounds: Record<string, number | string | undefined> = {
    minLength: schema.minLength,
    maxLength: schema.maxLength,
    minimum:
      integer && schema.exclusiveMinimum !== undefined
        ? schema.exclusiveMinimum + 1
        : schema.minimum,
    maximum:
      integer && schema.exclusiveMaximum !== undefined
        ? schema.exclusiveMaximum - 1
        : schema.maximum,
    exclusiveMinimum: integer ? undefined : schema.exclusiveMinimum,
    exclusiveMaximum: integer ? undefined : schema.exclusiveMaximum,
    minItems: schema.minItems,
    maxItems: schema.maxItems,
    enum: schema.enum?.map(String).toSorted().join("|"),
  };
  return Object.fromEntries(
    Object.entries(bounds).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  );
}

/** Every limit in a JSON Schema, by the field's path and the limit's name. */
function limits(schema: unknown, at = ""): Record<string, number | string> {
  const parsed = node.safeParse(schema);
  if (!parsed.success) {
    return {};
  }
  const { properties, items, anyOf, oneOf } = parsed.data;
  const found = Object.fromEntries(
    Object.entries(boundsOf(parsed.data)).map(([name, value]) => [`${at} ${name}`, value]),
  );
  for (const [name, child] of Object.entries(properties ?? {})) {
    Object.assign(found, limits(child, `${at}.${name}`));
  }
  if (items) {
    Object.assign(found, limits(items, `${at}[]`));
  }
  for (const option of [...(anyOf ?? []), ...(oneOf ?? [])]) {
    Object.assign(found, limits(option, at));
  }
  return found;
}

/** The limits outside the fields at `paths` (and inside them), which the API fills itself. */
function without(found: Record<string, number | string>, ...paths: string[]) {
  return Object.fromEntries(
    Object.entries(found).filter(
      ([key]) => !paths.some((path) => key.startsWith(`${path} `) || key.startsWith(`${path}.`)),
    ),
  );
}

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });

/** What a procedure accepts: its input before any transform. */
function accepted(schema: z.ZodType | undefined) {
  expect(schema).toBeDefined();
  return z.toJSONSchema(schema ?? z.never(), { io: "input", unrepresentable: "any" });
}

describe("Director's contract and the AI service", () => {
  it("share a locate's limits and answer", () => {
    const request = node.parse(json(zLocateRequest));
    const target = node.parse(request.properties?.target);
    const image = node.parse(request.properties?.image);
    expect(target.maxLength).toBe(DIRECTOR_LOCATE_TARGET_MAX_LENGTH);
    expect(image.maxLength).toBe(DIRECTOR_FRAME_MAX_LENGTH);
    expect(image.minLength).toBe(DIRECTOR_FRAME_MIN_LENGTH);
    const label = node.parse(node.parse(json(zLocated)).properties?.label);
    expect(label.maxLength).toBe(DIRECTOR_MARK_LABEL_MAX_LENGTH);
    expect(shape(json(locatedSchema))).toEqual(shape(json(zLocated)));
  });

  it("describe the same plan, field for field", () => {
    const plan = shape(json(zShotPlan));
    // Every field down to the pose's joints, not a comparison of two empty walks.
    expect(Object.keys(plan)).toEqual(
      expect.arrayContaining([
        ".shots[].pose.keypoints[].name",
        ".shots[].steps[].cameraMove",
        ".assets[].reference.aspectRatio",
        ".edits[].transition",
        ".edits[].box.width",
      ]),
    );
    expect(shape(json(shotPlanSchema))).toEqual(plan);
    expect(node.parse(node.parse(json(zShotPlan)).properties?.shots).maxItems).toBe(
      DIRECTOR_MAX_SHOTS,
    );
  });

  it("share an editor request's limits, the edit's state included", () => {
    const api = limits(accepted(contract.editor.ask["~orpc"].inputSchema));
    expect(api).toMatchObject({
      ".state.shots maxItems": DIRECTOR_MAX_SHOTS,
      ".state.shots[].position maximum": DIRECTOR_MAX_SHOTS - 1,
      ".audioType enum": "audio/mp4|audio/ogg|audio/webm",
    });
    expect(api).toEqual(limits(json(zEditorRequest)));
  });

  it("share a re-plan's limits, the member's version included", () => {
    const api = limits(accepted(contract.yourVersion.revise["~orpc"].inputSchema));
    expect(api).toMatchObject({
      ".instruction maxLength": 300,
      ".version.skipped[] maximum": DIRECTOR_MAX_SHOTS - 1,
      ".version.shots[].where maxLength": 300,
    });
    expect(api).toEqual(limits(json(zReviseRequest)));
  });

  it("share a brainstorm's limits, but for the photos the API reads for it", () => {
    const api = limits(accepted(contract.director.brainstorm["~orpc"].inputSchema));
    expect(api).toMatchObject({ ".messages[].text maxLength": 500, ".photos maxItems": 4 });
    expect(without(api, ".photos[]")).toEqual(
      without(limits(json(zBrainstormRequest)), ".photos[]"),
    );
  });

  it("share a match cut's limits, but for the takes the API reads for it", () => {
    const api = limits(accepted(contract.director.alignMatchCut["~orpc"].inputSchema));
    expect(api).toMatchObject({ ".anchor maxLength": 120, ".outgoing.atMs maximum": 60_000 });
    // The member names each take; the API sends the service a read of it, as its type.
    const service = limits(json(zMatchCutRequest));
    expect(without(api, ".outgoing.takeId", ".incoming.takeId")).toEqual(
      without(
        service,
        ".outgoing.url",
        ".outgoing.contentType",
        ".incoming.url",
        ".incoming.contentType",
      ),
    );
  });

  it("take every attempt the recording rules let a part hold to the clipper", () => {
    const clip = limits(json(zClipRequest));
    expect(clip).toMatchObject({
      ".contentType enum": RECORDING_TYPES.toSorted().join("|"),
      ".slices maxItems": RECORDING_MAX_SLICES_PER_PART,
      ".slices[].durationMs minimum": 1,
      ".slices[].durationMs maximum": RECORDING_SLICE_MAX_MS,
      ".slices[].startMs maximum": RECORDING_PART_MAX_MS,
      ".startMs maximum": RECORDING_PART_MAX_MS,
      ".endMs maximum": RECORDING_PART_MAX_MS,
      ".pauses[].startMs maximum": RECORDING_PART_MAX_MS,
      ".pauses[].endMs maximum": RECORDING_PART_MAX_MS,
    });
  });
});
