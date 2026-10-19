# Director v2, slice 12: gaps filled with stock and AI, and the saved video renders every asset

Spec: docs/superpowers/specs/2026-10-18-director-ux-redesign.md on origin/master. Read sections 1, 4, 7.3, 8 in
full (8.5 rendering, 8.7 gaps, 8.8 costs, 8.9 acceptance incl. the b5G8cbgh7K0 criteria), 9.3-9.4, 12 (slice 12),
14, and 15's slice 12 script. Rules: v2-common.md in this directory (time box applies: push working code
within ~75 minutes, lint + check-types + unit tests of what you touch).

Two jobs, both needed for the demo:
1. Rendering: the saved video (the stitch in apps/api, look for stitch.ts and the editor save path) must
   render what the editor shows: picked assets in their slots (images, B-roll, overlays, text, end card) and the
   plan's edit list (layout, grades, text) as far as the edit list on master describes. Slice 10 reported that
   picked assets are not rendered in the saved video yet; that is this job.
2. Gaps (8.7): shots the member skipped or never filmed are filled with stock B-roll (Pexels/Pixabay, credits)
   or a Veo 3.1 Lite clip, with the synthetic-content flag set on publish when AI footage is used.

Base: slice 10 (the asset picker, stock providers) is being rebased right now on feat/mm/v2-asset-picker. Start
by reading the spec and the code on origin/master. Then wait until
`git merge-base --is-ancestor origin/master origin/feat/mm/v2-asset-picker` succeeds after a fetch (check every
few minutes; the controller may also merge it into master, in which case base on origin/master) and branch
feat/mm/v2-gaps from it. Stock keys (PEXELS/PIXABAY) may be absent in prod: the fallback is Veo, and with no
Veo budget a held frame of the nearest take; never a black gap. Stack: 5.
