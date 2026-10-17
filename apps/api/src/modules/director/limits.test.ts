/**
 * Director's contract matches the Python service's models (the schemas generated from
 * apps/ai's Pydantic models): the input limits, so a request the API accepts is never one
 * the service refuses, and the plan's shape, so every plan the service returns parses
 * here, field for field and value for value.
 */
import { zSceneCheckRequest, zShotPlan } from "@repo/ai-client/schemas";
import {
  DIRECTOR_FRAME_MAX_LENGTH,
  DIRECTOR_FRAME_MIN_LENGTH,
  DIRECTOR_MAX_SHOTS,
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

  it("describe the same plan, field for field", () => {
    const plan = shape(json(zShotPlan));
    // Every field down to the pose's joints, not a comparison of two empty walks.
    expect(Object.keys(plan)).toEqual(
      expect.arrayContaining([".shots[].pose.keypoints[].name", ".shots[].steps[].cameraMove"]),
    );
    expect(shape(json(shotPlanSchema))).toEqual(plan);
    // No `maxItems` on `shots` (or on `steps`, `script`, `pose.keypoints`, not asserted
    // here): Vertex AI answers 400 INVALID_ARGUMENT to a ShotPlan schema carrying any
    // array bound at all, so DIRECTOR_MAX_SHOTS is enforced by the AI service's
    // repair_plan trimming an answer that runs over, never by the declared schema.
    expect(node.parse(node.parse(json(zShotPlan)).properties?.shots).maxItems).toBeUndefined();
  });
});
