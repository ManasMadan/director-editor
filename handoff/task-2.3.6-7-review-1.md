(Review 1 of tasks 2.3.6+2.3.7 — fix these; file:line refer to your branch at d266c2d.)

Important
1. edit.tsx:2498-2543 / lib/stitch.ts ~149+ — the editor stays live during a render that can take up to 3 minutes, and leaving doesn't cancel it: picks/styles changed mid-render are silently left out; the Saved overlay builds captions from the current clips (:2546) not the rendered ones; stitch takes no abort signal, so leaving via X/Retake keeps rendering and then uploads up to 100 MB and saves a cut nobody watches (recorder, AudioContext, video elements stay alive after unmount). Fix: while saver.busy disable the board, transport and links, with a Cancel button; pass an AbortSignal from an unmount cleanup (and Cancel) into stitch that stops the recorder, pauses the current video and skips the upload; give Saved the clips that were rendered. Tests: cancel mid-render → no upload, no cut; controls disabled while busy.
2. shot-board.tsx:999,:1189 / hooks/use-studio.ts:41 — Retake from the editor opens shoot?shot=i and, after the take is kept, walks on to shot i+1…n before wrapping to /edit. Carry a return target (e.g. &then=edit), parse it in the shoot route, and have nextPage return to /edit?audio=… once the retake is kept. Fix the stale comment in submit-take.ts. Test it.

Minor (do them)
1. shot-board.tsx:1011-1024 — a failed review shows no reason: restore `errorMessage({ code: take.error ?? "DIRECTOR_REVIEW_FAILED" })` in ReviewLine.
2. edit.tsx:2151 — the after-render oversize message says "too long… up to 3 minutes" even for a short cut whose bitrate overshot: separate copy ("came out too big; try shorter takes") with FILE_TOO_LARGE's maxBytes.
3. shot-board.tsx:1101-1103 — stepping to the first/last take disables the focused button and focus drops to <body>: use aria-disabled or move focus to the other button.
4. use-take-media.ts:1403-1413 — a failed take download stays in `started`, never retries, and blocks Save until reload: drop it from `started` on failure (retry on next pick).
5. track.ts:1965-1971 — shots under ~2.8 s all get the 156 px minimum: lower the floor / adjust px-per-second so x stays roughly proportional to time while short shots stay tappable.
6. edit.tsx:2190 — the Saved overlay isn't a dialog: use the packages/ui dialog primitive (role, focus trap, Escape).
7. docs/director.md:69 — /review → /edit, add /media.
8. Add a Playwright e2e spec in apps/web/e2e for editor → save → My media with expectAccessible (the web rule wants one for a cross-page flow). CI runs with Director off (no YouTube key): structure it so it runs where Director is on and doesn't need a skip that the lint refuses — check how apps/web/e2e handles that today (e.g. platform.spec.ts / library.spec.ts) and follow the same pattern; if it must be skipped in CI, list it in docs/testing.md like library.spec.ts.
9. (optional) media.tsx:2773 — tell cuts of the same template apart (time or "Version n").

Also (controller): rebase onto origin/feat/mm/director-hackathon first (seed copying, the indexer with stages, the landing page, the demo account soon). The library/shell agent will add the "My media" nav entry; keep your /media route-list change and resolve any conflict in src/lib/routes.ts keeping both. Verify ⚠️ from the review in a real browser with playwright-cli at phone width: picking a take must not make the board jump to another shot; fix it if it does.
