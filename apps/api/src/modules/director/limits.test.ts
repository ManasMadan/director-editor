/**
 * Director's contract matches the Python service's models (the schemas generated from
 * apps/ai's Pydantic models): the input limits, so a request the API accepts is never one
 * the service refuses, and the plan's shape, so every plan the service returns parses
 * here, field for field and value for value.
 */
import {
  zLocated,
  zLocateRequest,
  zSceneCheckRequest,
  zShotPlan,
} from "@repo/ai-client/schemas";
import {
  DIRECTOR_FRAME_MAX_LENGTH,
  DIRECTOR_FRAME_MIN_LENGTH,
  DIRECTOR_LOCATE_TARGET_MAX_LENGTH,
  DIRECTOR_MARK_LABEL_MAX_LENGTH,
  DIRECTOR_MAX_SHOTS,
  locatedSchema,
  shotPlanSchema,
} from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import * as z from "zod";

const node = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  maxLength: z.number().optional(),
  minLength: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
  maxItems: z.number().optional(),
});

/** Each field's path in a JSON Schema, with the values an enum allows. */
function shape(schema: unknown, at = ""): Record<string, string> {
  const parsed = node.safeParse(schema);
  if (!parsed.success) {
    return {};
  }
  const { properties, items, anyOf } = parsed.data;
  const found: Record<string, string> = parsed.data.enum
    ? { [at]: parsed.data.enum.join("|") }
    : {};
  for (const [name, child] of Object.entries(properties ?? {})) {
    Object.assign(found, { [`${at}.${name}`]: "field" }, shape(child, `${at}.${name}`));
  }
  if (items) {
    Object.assign(found, shape(items, `${at}[]`));
  }
  for (const option of anyOf ?? []) {
    Object.assign(found, shape(option, at));
  }
  return found;
}

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });

describe("Director's contract and the AI service", () => {
  it("share the scene check's limits", () => {
    const request = node.parse(json(zSceneCheckRequest));
    const image = node.parse(request.properties?.image);
    const shotIndex = node.parse(request.properties?.shotIndex);
    expect(image.maxLength).toBe(DIRECTOR_FRAME_MAX_LENGTH);
    expect(image.minLength).toBe(DIRECTOR_FRAME_MIN_LENGTH);
    expect(shotIndex.exclusiveMaximum).toBe(DIRECTOR_MAX_SHOTS);
  });

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
      expect.arrayContaining([".shots[].pose.keypoints[].name", ".shots[].steps[].cameraMove"]),
    );
    expect(shape(json(shotPlanSchema))).toEqual(plan);
    expect(node.parse(node.parse(json(zShotPlan)).properties?.shots).maxItems).toBe(
      DIRECTOR_MAX_SHOTS,
    );
  });
});
