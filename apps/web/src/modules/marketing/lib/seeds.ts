/**
 * The seed the landing x-rays, from Director's 6 shared seed templates
 * (@repo/contracts/director-seeds: indexed for real with Gemini, checked against the plan's
 * contract when loaded, and the same templates every new workspace starts with).
 *
 * The first seed, a talking head whose plan fills every guide the phone draws: framing,
 * a pose with a head, lines to say. Read on the server only (the landing is a server
 * component), so none of the seed data reaches the browser's JavaScript.
 */
import { directorSeeds } from "@repo/contracts/director-seeds";
import { required } from "@repo/contracts/objects";

const seed = required(directorSeeds[0], "Director's first seed template");

export const XRAY = {
  ...seed,
  /** A plan always has a shot (the contract's minimum is one). */
  firstShot: required(seed.plan.shots[0], "the first seed's first shot"),
};
