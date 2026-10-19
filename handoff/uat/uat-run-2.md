# UAT run 2: production v1.7.1 (release sha-1428d07), director.mmadan.in, 2026-10-19

Tester: automated product UAT, run 2. Same harness as run 1 (raw-run-1/driver.mjs, inject.js): Google Chrome (headless, `channel: chrome`) driven by playwright-core, fake camera from the owner's indoor footage (720×1280 y4m), a scripted microphone that plays macOS `say` lines into the page at chosen moments, every relay message, Director audio chunk, caption change and tool call timestamped.
Changes to the harness for run 2 (in raw-run-2/): `inject2.js` also records the **visible** caption bubbles (v1.7.1 only updates the aria-live line once a line is finished, so run 1's aria-live measure would now overstate the lag); `driver2.mjs` loads an explicit guest state. Phone profile 390×844, DPR 3, touch, Android Chrome UA.
Accounts: private guests from "Try it now" (headed Chrome without the automation flag, then cookies moved to the phone profile). Guest A for slices 1-5, 8, 14; guest B for slice 7, 9, 10, 15.
Budget used is tallied at the end (Live sessions, saves, indexings, AI images).

## Re-test table

(filled in at the end of the run; see sections below for evidence)

## Sign-in (guest A)

- First "Try it now" (headed desktop Chrome, `navigator.webdriver` false): landed on `/sign-in?demo=1` showing a Turnstile "Verify you are human" checkbox **and at the same time** "Your own demo couldn't start just now…" plus the red "The security check couldn't load. Check your connection, allow challenges.cloudflare.com… and reload." `screens-run-2/00-guest-guestA.json.png`. UAT1-03 (contradictory copy) still reproduces. Console: `Fetch API cannot load data:,` CSP error (UAT1-02, still present; engineering says it's Cloudflare's frame).
- Second try, same browser setup: straight to /library in 13 s, no click needed. Page title for a "Try it now" visitor while it works: "Welcome back · Director" (UAT1-04 still reproduces).
