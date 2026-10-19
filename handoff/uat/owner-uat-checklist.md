# Owner UAT checklist — production v1.7.1 (sha-1428d07)

Setup: phone (iPhone Safari first, then Android Chrome), quiet room, screen recording with mic on, say "v1.7.1, <phone>, <test>" at the start. Sign in with Google (your account was deleted, so it's fresh) or "Try it now". Note the clock time when you start each test so I can match logs.

## A. Your bugs (U1–U8) — each needs a pass/fail from you

1. Indoors re-plan (U1, U5): open the head-nod Short → Start shooting. When Director mentions the market say "I'm switching indoors, I'll shoot everything at home". Expect: every remaining shot's card moves indoors, an "Inside" chip, Director never mentions the market again. Film 2 shots, tap Done. In the editor: reviews never say "outdoors"/"street", shot titles aren't "…in the Market".
2. Shot jumps (U4): after the re-plan, keep talking. Expect: the screen never moves to another shot unless you ask ("next shot").
3. Director stops / replies late (U3): normal back-and-forth for 2 minutes; interrupt once with "wait, wait". Expect: no mid-sentence cut-offs you didn't cause, replies within ~1.5 s, stops when you interrupt.
4. Captions (U2): watch captions vs voice. Expect: words appear as they're spoken, not after.
5. Takes (U6, U8): do 3 attempts at one shot with chat between, tap Done. Expect: 3 takes, none "Director couldn't review this take", none under half a second, none containing Director's own voice or "I'm ready".
6. Saved video (U7): Save video in the editor, keep the screen on. Download it from My media. Expect: same length as the edit, picture and sound in sync, no frozen frame, captions throughout, your voice audible.

## B. New in v1.6–v1.7 (smoke)

7. Memory: say "one angle is fine, I don't want other angles" → one-line confirmation + chip; reload the page → Director still knows.
8. Picks: 4 attempts, make the 3rd your best, then say "actually use the second one" → editor shows take 2 first ("Your pick"), Director's pick with a reason, one tap swaps.
9. Tell Director (editor bar): "use the take where I'm smiling", "swap shots 2 and 3", "captions off", "undo that".
10. Create from scratch: library → Describe your own → "20 seconds of my morning coffee, cosy, no talking" + 2 photos → answer ≤3 questions → Write my shots → edit one shot, delete one.
11. Asset Short: paste https://youtube.com/shorts/OvRozQobeuI → template shows asset slots → open a slot → upload / create with AI.
12. Leaving: during recording tap ✕ → asks Stay/Leave (known: fix for the off-screen ✕ and the confirm is in v1.7.2, not live yet).

## C. Known not yet in production (coming in v1.7.2 — don't log as new)

Off-screen ✕ on the roll's top bar at 390 px; ✕ without confirmation during the roll; sessions left "recording" after closing the tab; demo account start card; editor choices lost on reload; privacy/terms placeholders; slow page loads (LCP 4.5–6.8 s) and the 1.3 s editor freeze; library sideways scroll at 360 px; ~30 UI/copy items; saved video encoder backlog on slow phones.

## Send me

Per test: pass/fail, the clock time, one line on what felt wrong. Video if something fails.
