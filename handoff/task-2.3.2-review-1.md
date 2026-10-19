(Review 1 of task 2.3.2 — fix these; file:line refer to your branch at 2474acc.)

Important
1. original-player.tsx:143,156 — the play button's focus ring is clipped by the `overflow-hidden rounded-3xl` wrapper (focus-visible:ring-4 is an outer shadow): keyboard users see no focus (WCAG 2.4.7). Use `focus-visible:ring-inset` or a ring on the wrapper via `has-[:focus-visible]:ring-4`.
2. en.json `home.cloud.bigquery.use` — "Records every indexing, take and score" overclaims. Word it exactly to what the merged code records: after you rebase (below), grep the repo for the analytics kinds actually emitted (`record("call_started"` in apps/api, `take_reviewed` with score in apps/ai, and `indexed` if the indexer task has merged by then). Keep it factual.

Minor (do them)
3. original-player.tsx — focus is lost to <body> after pressing play: focus the iframe once it mounts (YouTubeEmbed forwards a ref).
4. home.tsx h1 `lg:text-7xl` breaks into four lines at 1440px; make it two lines (lg:text-6xl or a wider text column).
5. xray.tsx — the "Hold the phone at eye level" note and pose lines sit on top of the script line and the thumbnail's own caption shows through: move the note up near the framing box, darken the bottom gradient below ~60%.
7. home.proof.body "The Short above" doesn't match the layout: e.g. "This Short, and the shots Gemini found in it."
10. site-chrome.tsx:21 — the footer sits inside <main>; make it a page-level <footer> (contentinfo) and label its nav "Legal".
9. Take fresh dark-mode screenshots after these changes.
(6, the look-alike mini frames in the shot strip, is optional: improve if cheap, e.g. a tiny pose figure per frame.)

Also (controller): task 2.2.2 has merged — the seed templates now live in packages/contracts/src/director-seeds.json (exported by packages/contracts/src/director-seeds.ts, zod-checked). Rebase onto origin/feat/mm/director-hackathon, switch the landing's seed data to that shared import, and delete apps/web/src/modules/marketing/lib/seed-excerpt.json and its drift test. Add the e2e check the reviewer asked for: a signed-in member's template card opens a ready plan (seeds are copied at sign-up now).
