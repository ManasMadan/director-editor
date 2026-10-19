(Review 1 of tasks 2.3.4+2.3.5+2.3.1b — fix these; file:line refer to your branch at 764b37b.)

Important
1. apps/web/src/modules/director/pages/director.tsx:183-188 — at phone width the back arrow + "Director" pill sit over the YouTube player's own title overlay (shown at start and when paused, even with controls=0; the iframe is pointer-events-none so it can't be dismissed). Take the top bar out of the overlay: a solid row above the player (back link, title, mute toggle — like the not-ready Header), drop the redundant "Director" pill; account for env(safe-area-inset-top).
2. Docs and rules still point at deleted files: .claude/rules/client.md (src/api/shorts/reacted.ts, api.shorts.feed.key()), .claude/skills/add-web-page/SKILL.md, docs/director.md (/shorts/[videoId] route), docs/web-and-mobile.md, plus .claude/rules/api.md, contracts.md, the add-feature skill, apps/api/CLAUDE.md as your report listed. Update each to point at code that exists (the library/director modules). The owner has pre-authorized guard-rail/rules edits for this build.

Minor (do them)
3. director.tsx:207 — make the plan title the page's h1 on the ready template page.
4. shot-list.tsx:201-208 — six buttons all named "Watch this part": use the existing `template.watchShot` key as aria-label; make shot titles headings.
5. credit-dialog.tsx:34 — pass `finalFocus` to the link input so focus doesn't drop to <body> after "Got it".
6. director.tsx:271-280 — "Start shooting" navigates: make it a Link, not a button calling router.push.
7. template-card.tsx:90 / i18n library.card.user — the "Indexed" badge is wrong while indexing/failed: use "Yours".
8. director.tsx:246 — smooth scrollTo should respect prefers-reduced-motion.

Also (controller): origin/feat/mm/director-hackathon has moved (seed copying 2.2.2, the Cloud Run indexer 2.1.3+2.1.5 with stages): rebase onto it first (expect conflicts in apps/web/test/fake-ai.ts, en.json, the api director tests — resolve them keeping both sides' behavior). With seeds copied at sign-up now, your library screenshots should show the 6 real seed templates — re-take them. Point the shell's nav at /media only if /media exists after the rebase (it doesn't yet; 2.3.7 adds it).
