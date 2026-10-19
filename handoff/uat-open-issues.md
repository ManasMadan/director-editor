# UAT open issues (owner-found; stay open until the owner re-tests them on a phone, whatever engineering says)

| # | Found | Issue | Engineering status | Owner re-test |
|---|---|---|---|---|
| U1 | v1.4.0 | "Switching indoors" changed only shot 1; later shots still outdoor | Fixed in v1.6.0 (slice 4), live Vertex re-plan check passed | open |
| U2 | v1.6.0 | Captions come late compared with Director's voice | fixer fix/mm/live-turns (caption store + timing logs; cause likely Gemini transcript lag) | fix LIVE in v1.7.0 (#38) + more in #44/#45 (next release); awaiting owner re-test |
| U3 | v1.6.0 | Director stops a lot mid-turn; sometimes replies very late | fixer fix/mm/live-turns (relay notes interrupt Director mid-turn) | fix LIVE in v1.7.0 (#38) + more in #44/#45 (next release); awaiting owner re-test |
| U4 | v1.6.0 | When Director updates the plan, the shoot screen randomly moves to the next shot | fixer fix/mm/live-turns (Director calls go_to_shot after plan change) | fix LIVE in v1.7.0 (#38) + more in #44/#45 (next release); awaiting owner re-test |
| U5 | v1.6.0 | Reviews say "film outdoors" after the member chose indoors; editor shot titles still "in the Market" | fixer fix/mm/reviews (review uses original shot; no version title) | fix LIVE in v1.7.0 (sha-a2d815d); awaiting owner re-test |
| U6 | v1.6.0 | Some takes: "Director couldn't review this take. Record it again." | fixer fix/mm/reviews (Gemini 429/5xx retries exhausted; log error type) | fix LIVE in v1.7.0 (sha-a2d815d); awaiting owner re-test |
| U7 | v1.5/1.6 | Exported Short broken: one video frame lasts 10.4 s (freeze 6.6–16.9 s), audio 38.9 s vs video 20.4 s, second clip's speech 3.6 s after its picture, captions only at the end | fixer on fix/mm/export-sync | fix LIVE in v1.7.0 (sha-a2d815d); awaiting owner re-test |
| U8 | v1.6.0 | Takes of 0.1–1 s reach the editor (clipper/recording emits uselessly short takes) | in U7's fixer scope | fix LIVE in v1.7.0 (sha-a2d815d); awaiting owner re-test |
