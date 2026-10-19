# Director v2, slices 8 + 14: find a take by describing it, and the full conversational editor

Spec: docs/superpowers/specs/2026-10-18-director-ux-redesign.md on origin/master. Read sections 1, 4, 9 in full
(especially 9.2 picks, 9.3 edit list, 9.6 the conversational editor and its parrot criteria), 12 (slices 8 and 14),
14 and 15's scripts for 8 and 14. Rules: v2-common.md in this directory (time box applies: push working code
within ~75 minutes, lint + check-types + unit tests of what you touch).

Slice 8: the take index at clipping time (what is visible, what is said, when, quality; Gemini 3.8 Flash on the
clipped attempt, optional Vertex embeddings), and picking takes by description: one, several or no matches.
Acceptance: the parrot criteria in 9.6.
Slice 14: everything else in 9.6: the "tell Director" bar on the editor accepts plain-language requests
(swap a take, trim, reorder, change music, regenerate an asset, add text) and turns them into edits on the
existing edit list / picks through tools Gemini calls; spoken or typed; confirms in one line; undo.

Base: origin/master (slices 1, 2, 3 incl. the roll UI, 7, 9 assets, 11 marks are in). Slice 5 (picks with
reasons) is still building on feat/mm/v2-picks and slice 10 (asset picker) on feat/mm/v2-asset-picker: don't
depend on their code; put your editor request handling behind a small seam they can plug into
(e.g. an editor-actions module in apps/api and a hook in packages/client), and note where they join.
Branch: feat/mm/v2-editor-talk. Stack: 4.
