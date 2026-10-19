# UAT UI run 1 (second tester): every screen, responsiveness, a11y, performance

Target: https://director.mmadan.in (production, v1.6.0). Date: 2026-10-19.
Browser: Chromium (Playwright 1.63 bundled), headless, fake camera/mic
(`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`).
Phone profiles: 360x740, 390x844, 430x932 (touch, mobile UA, DPR 3), landscape 844x390;
tablet 768x1024; laptop 1280x800, 1440x900. Screenshots in `screens-ui-run-1/`.
Known issues (findings.md B/L/R/S/E/M/F, uat-open-issues.md U1-U8) are not re-reported
as new; where I confirm one I say so.

Severity: blocker / major / minor / polish. Category: functional / UX / UI / responsive / a11y / performance.

## Log (appended as I go)

### Setup notes
- Demo sign-in: headless Chromium fails Cloudflare Turnstile (401 from challenges.cloudflare.com), so "Try it now" always fell back to the shared demo account here. I used the shared account (`demo@director.mmadan.in`) for the authed screens. Real browsers usually pass Turnstile, so the fallback findings below are about what a person sees when the challenge does not pass (blockers, privacy browsers, flaky networks).
- Console noise excluded from findings: Next.js `_rsc` prefetch aborts, Turnstile's own iframe CSP errors (`connect-src ... data:,`), `%c%d` and "No available adapters" (Turnstile fingerprinting), YouTube embed `stats/watchtime` aborts, and the WOFF2 OTS warning, which appears only on pages that mount Turnstile.

---

### UI1-01 Library overflows sideways at 360 px; right edge of every card cut off
- Severity: major. Category: responsive. Viewport: 360x740 (overflow) and 390x844 (right gutter gone). 430 and up are fine.
- Where: https://director.mmadan.in/library, the whole page body (`main > div.grid`).
- Steps: sign in, open /library at 360 px wide.
- Expected: content fits with the 16 px gutters on both sides; no sideways scroll.
- Actual: `document.scrollWidth` = 388 vs 360 viewport: the page scrolls sideways by 28 px. The intro paragraph ("...into sho"), the "Bring your own Short" card, the link field, the "Index it" button, the "Describe your own" card and the Quick start card are all cut at the right edge; the gradient border of the index card is missing on the right. At 390 the same 372 px column fits the viewport but not the container: 16 px gutter on the left, ~2 px on the right, the intro text and the cards run into the screen edge (`lib-paste-xss.png`).
- Evidence: `screens-ui-run-1/sweep-authed2-library-p360.png`. Probe: the page grid's single implicit column resolves to 371.7 px; the template list `ul.grid.grid-cols-2` makes two 180 px items + 12 px gap = 372 px, and that min-content drives the outer auto column.
- Suspected code: `apps/web/src/modules/director/pages/library.tsx`, root `div.grid gap-8 ... lg:grid-cols-[...]` has no base `grid-cols-1`/`minmax(0,1fr)` so the implicit `auto` track grows to the nested 2-column grid's content width; `components/template-card.tsx` sets the 180 px min-content.

### UI1-02 Header nav wraps "My media" onto two lines at 360 px
- Severity: minor. Category: responsive / UI. Viewport: 360x740.
- Where: every signed-in page, site header `nav[aria-label=Main]`.
- Steps: sign in, open /library at 360 px.
- Expected: one-line tabs ("Library", "My media"), or a compact nav that fits.
- Actual: "My" and "media" stack on two lines, the header grows and the tab looks broken next to the pill-shaped "Library".
- Evidence: `screens-ui-run-1/sweep-authed2-library-p360.png` (top).
- Suspected code: `apps/web/src/modules/shell/components/site-header.tsx` (nav links need `whitespace-nowrap` or a smaller gap/brand at < 375 px).

### Template page (/director/22k0fZarxh8)
Checked at all seven viewports: no sideways scroll at any width. Working: back arrow, mute/unmute (label flips Unmute to Mute), the storyboard strip buttons (each scrolls to top and plays that part of the original), "Watch this part", the speech choice (the "Let's shoot" link changes to `audio=original`), the soundtrack button, the Veo preview button (turns into pause, caption changes to "Preview made with Veo"), and the sticky "Let's shoot" (the page has enough bottom padding that the last card clears it). Note: Playwright's bundled Chromium can't play the H.264 previews, so from here on I ran Google Chrome (`channel: chrome`) for anything with media.

### UI1-03 Internal beat labels shown raw on every shot card ("hook:", "setup:", "reveal:", "payoff:")
- Severity: minor. Category: UX (copy).
- Viewport: all.
- Where: /director/22k0fZarxh8, "Film them in this order", the subtitle under each shot title.
- Steps: open any template, scroll to the shot list.
- Expected: plain sentence-case copy for the member (quality bar: never show field names; UI copy is sentence case, second person).
- Actual: "hook: introduce the cultural observation in a lively setting, curious and friendly", "setup: demonstrate the first variation, playful and clear", "reveal: ...", "payoff: wrap up with a sweet personal takeaway ... endearing". These are the plan's beat/tone fields joined with a colon, lower case, third person.
- Evidence: `screens-ui-run-1/tpl-390-01.png`, `tpl-390-02.png`, `tpl-390-bottom.png`.
- Suspected code: `apps/web/src/modules/director/components/shot-list.tsx` (renders `beat: purpose, tone` verbatim).

### UI1-04 Shot cards tell a solo member to use the "Back camera" on a template sold as "Just you, talking to the camera"
- Severity: minor. Category: UX (content consistency).
- Viewport: all.
- Where: /library Quick start card ("Just you, talking to the camera. Works indoors.") vs /director/22k0fZarxh8 shot cards, "Phone" row.
- Steps: read the Quick start card; open it; read each shot's "Phone" row.
- Expected: a talking-to-camera template, which the shoot screen opens on the selfie side, says "Front camera" (or nothing).
- Actual: every shot of the Quick start says "Hold the phone at eye level / Held level / Back camera", and shots 1, 2, 4, 6, 8 and 10 ask to "Stand in a busy outdoor market street" right below "Works indoors".
- Evidence: `screens-ui-run-1/tpl-390-01.png`, `tpl-390-bottom.png`; `sweep-authed2-library-p390-full.png`.
- Suspected code: plan display in `components/shot-list.tsx`; content comes from the seed plan (the original's camera), so either map it for the member or hide it for selfie-capable shots.

### UI1-05 Storyboard strip hides shot 10 with no sign it scrolls
- Severity: polish. Category: UI / responsive.
- Viewport: 360, 390, 430 (strip scrollWidth 396 vs 358 visible at 390).
- Where: /director/22k0fZarxh8, "You need 10 shots: 10 videos and no photos." strip (`ul[aria-label=Storyboard]`).
- Steps: open the template on a phone and look at the strip.
- Expected: all 10 tiles visible, or a visible cue (fade, partial tile, arrow) that it scrolls.
- Actual: tiles 1-9 fill the row exactly and tile 10 sits fully off-screen; the row ends flush, so it reads as "9 shots" right under "You need 10 shots".
- Evidence: `screens-ui-run-1/tpl-390-01.png`; probe `{sw:396, cw:358, overflowX:auto, mask:none}`.
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` (storyboard strip in `Hero`/`Ready`).

### UI1-06 Hero meta chips sit on top of YouTube's own player chrome
- Severity: polish. Category: UI.
- Viewport: 390 (also 360/430).
- Where: /director/22k0fZarxh8 hero, the "Travel Observation / Cultural Vlog", "00:36" and "10 shots" chips.
- Steps: open the template; let the embed play.
- Expected: chips below the video or on a scrim that hides the player chrome under them.
- Actual: the chips overlap YouTube's caption/"More videos" strip and the YouTube logo; text from both layers shows through each other ("while... notic...", "nd India", "YouTube" behind "00:36").
- Evidence: `screens-ui-run-1/tpl-390-00.png` (bottom of the video).
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` `Hero` overlay.

### UI1-07 Template page is a 512 px phone column on laptops; on a phone in landscape the sticky CTA and header take a third of the screen
- Severity: minor. Category: responsive.
- Viewport: 1280x800, 1440x900, 844x390.
- Where: /director/22k0fZarxh8.
- Steps: open the template on a laptop; then on a phone turned sideways.
- Expected: a laptop layout that uses the width (video beside the plan, as the library does), and in landscape a CTA that does not eat the viewport.
- Actual: at 1280 and 1440 the whole page is a ~512 px centred column with black on both sides, the plan starts below the fold and the 60 px red CTA spans the column. At 844x390 the header (66 px) plus the sticky CTA (~80 px with its margin) leave ~240 px for content, and the CTA covers the hero meta row.
- Evidence: `screens-ui-run-1/sweep-director_22k0fZarxh8-d1280.png`, `sweep-director_22k0fZarxh8-land.png`.
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` (single `max-w-lg` column, `fixed bottom` CTA).

### UI1-08 Soundtrack button keeps the name "Play the soundtrack" while it plays
- Severity: polish. Category: a11y.
- Where: /director/22k0fZarxh8, soundtrack row.
- Steps: tap the soundtrack play button; read its accessible name.
- Expected: the name says what a tap does now ("Pause the soundtrack"), like the mute button and the Veo preview do.
- Actual: name stays "Play the soundtrack" with `aria-pressed=true`; a screen reader hears "Play the soundtrack, pressed" while it is playing, inconsistent with the other two toggles on the same page.
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` `Soundtrack` (aria-label `playSoundtrack` fixed).

### UI1-09 A template link with a bad id shows "Some fields need attention." and a useless "Try again"
- Severity: major. Category: UX (error state / deep links).
- Viewport: all.
- Where: https://director.mmadan.in/director/doesnotexist1 (any id that isn't 11 YouTube characters; a mistyped or truncated shared link).
- Steps: signed in, open /director/doesnotexist1.
- Expected: a not-found state in plain words ("We can't find that Short") with a way back to the library; "Try again" only when trying again can help.
- Actual: `POST /rpc/director/plan` returns 422 and the page shows the generic form-validation message "Some fields need attention." (there are no fields) and a "Try again" button that repeats the same 422 forever. The header also switches to a clapperboard logo that appears nowhere else.
- Evidence: `screens-ui-run-1/sweep-director_doesnotexist1-p390.png`; console `Failed to load resource: 422 /rpc/director/plan`.
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` (`NotReady`/error branch maps every error through `useApiErrorMessage`, which turns `BAD_REQUEST`/validation into "Some fields need attention."); the shorts gate header in `apps/web/src/modules/shorts/components/director-gate.tsx`.

### UI1-10 Editor preview draws the "Shot 1 isn't filmed yet" placeholder underneath the burned-in captions
- Severity: minor. Category: UI.
- Viewport: 390 (all phone sizes; same at 1280).
- Where: /director/22k0fZarxh8/edit with unfilmed shots, the preview player.
- Steps: open the editor of a template you haven't filmed.
- Expected: either the placeholder ("Intro in the Market / Shot 1 isn't filmed yet") or the caption, readable.
- Actual: both are drawn in the same place; the grey placeholder letters show through and around the white caption ("AROUND INDIA,I'VE" has stray glyphs between the words), and a 7-line all-caps caption block covers most of the frame.
- Evidence: `screens-ui-run-1/edit-empty-390-player.png`, `sweep-director_22k0fZarxh8_edit-p390.png`.
- Related: F3 (unfilmed shots become captioned gaps). This is the on-screen collision, separate from the export.
- Suspected code: `apps/web/src/modules/director/components/edit-player.tsx` + `caption-layer.tsx` (gap placeholder and caption layer share the centre).

### UI1-11 No favicon, no touch icon, no manifest icons
- Severity: minor. Category: UI.
- Viewport: all.
- Where: every page; `/favicon.ico` and `/icon.svg` return 404; the HTML has no `<link rel=icon>`; `/manifest.webmanifest` has no `icons`.
- Steps: open any page; look at the tab; "Add to Home Screen" on a phone.
- Expected: the red-dot Director icon in the tab, in bookmarks and on the home screen (the manifest sets `display: standalone`, so an installed app gets a blank/letter icon).
- Actual: generic tab icon; a 404 for `/favicon.ico` in the console on every page load.
- Evidence: console `Failed to load resource: 404` (CDP: `https://director.mmadan.in/favicon.ico`); `curl /favicon.ico` 404.
- Suspected code: `apps/web/src/app/` (no `icon.*`/`apple-icon.*` file), `apps/web/src/app/manifest.ts`.

### UI1-12 Light and dark switch from page to page in the signed-in app
- Severity: minor. Category: UI (consistency).
- Viewport: all; system theme light (default).
- Where: /library, /media, /director/*, /create are dark; /settings, /settings/security, the 404 page, /privacy and /terms are light with the same dark header; the landing page is light.
- Steps: signed in, tap Library, then avatar > Settings, then a bad URL.
- Expected: one theme across the signed-in app (or the studio pages follow the theme toggle like the rest).
- Actual: the theme flips between neighbouring pages from the same nav; the header theme toggle has no visible effect on the studio pages (library, media) because they are always dark.
- Evidence: `sweep-media-p390.png` (dark) vs `sweep-settings-p390-full.png` (light) vs `sweep-authed2-nope_404-p390.png` (light).
- Suspected code: `apps/web/src/modules/shell/components/site-chrome.tsx` / the `studio` colour tokens used only by director pages.

### Library: paste-a-Short field
Tried (390 px): blank/spaces (button stays disabled: good), "hello", `https://example.com/shorts/abc`, `https://www.youtube.com/`, a watch URL, a youtu.be URL, `youtube.com/shorts/<id>` with no scheme, `?si=...&feature=share`, `m.youtube.com`, padded with spaces (all five forms of an existing template open it: good), a bad id, `<script>` (rendered as text: good), and a 600-character URL (silently cut at 300 characters by `maxLength`). I did not paste a new real Short, to avoid spending the shared account's one index and Gemini time.

### UI1-13 Opening templates from the paste field counts toward a 1-hour lockout, shared by every demo visitor
- Severity: major. Category: functional / UX.
- Viewport: any.
- Where: /library, "Bring your own Short" > "Index it" (`POST /rpc/director/index`).
- Steps: on the shared demo account, paste about ten links in a row (here: 4 invalid, 6 links to a template already in the library, which just open it), then paste one more.
- Expected: opening a Short that's already in the library is free; a rate limit, if hit, is short and said in minutes; one visitor can't lock the shared demo for everyone.
- Actual: the 11th call returns 429 `RATE_LIMITED retryAfterSeconds: 3052` and the card says "Too many attempts. Try again in 3,052 seconds." The limit is per account, and the demo account is shared, so every visitor who falls back to it is now locked out of indexing for ~51 minutes. Six of the ten calls only opened an existing template.
- Evidence: `screens-ui-run-1/lib-paste-xss.png`; responses logged: 4x 422, 6x 200 (`source: seed`), then 422, then 429 x2.
- Note for the other tester: the shared account's index limit was hit by this run shortly before 22:40 UTC (a ~51-minute lockout, long expired).
- Suspected code: API rate limit on `director.index`; copy in `packages/i18n` (`RATE_LIMITED` message renders raw seconds); `apps/web/src/modules/director/components/index-card.tsx` could resolve links to library templates client-side before calling the API.

### UI1-14 Non-links get "That video isn't on YouTube, or it's private"
- Severity: minor. Category: UX (copy / validation).
- Where: /library, paste field.
- Steps: type "hello" (or `https://example.com/shorts/abc`, or `https://www.youtube.com/`) and tap "Index it".
- Expected: "That isn't a YouTube Shorts link" straight away, without a server round trip (and without using up the rate limit above).
- Actual: a request goes to the API and the reply is `DIRECTOR_VIDEO_UNAVAILABLE`: "That video isn't on YouTube, or it's private. Check the link and try again." It reads as if the link were a real video.
- Evidence: `screens-ui-run-1/lib-paste-word.png`, `lib-paste-other-site.png`.
- Suspected code: `apps/web/src/modules/director/components/index-card.tsx` (no client parse); API maps unparsable URLs to `DIRECTOR_VIDEO_UNAVAILABLE`.

### Create from scratch (/create, /create/BA1mDsjg5Iw)
Worked end to end at 390: typed idea, uploaded a generated 720x1280 PNG (thumbnail dims while uploading, then sharp; remove button present), "Talk it through" (5.1-5.5 s per reply), one typed answer, "Write my shots" (button reads "Asking Director...", then a full-screen "Director is writing your shots / This takes about a minute. You can leave this page", ~10 s here), then the editable shot list with up/down/delete per shot, "Add a shot" and "Looks good, let's shoot". The forced-error state is fine ("Something went wrong on our side. Please try again." in a `role=alert`). No overflow at any width.

### UI1-15 "Talk it through" shows no loader for the first question (5 s of nothing)
- Severity: minor. Category: UX (loading state).
- Viewport: all.
- Where: /create, "Talk it through".
- Steps: type an idea, tap "Talk it through".
- Expected: the Gemini loader with words while Director thinks (quality bar: never a bare wait), as it does for later answers.
- Actual: for the first call both buttons just grey out for ~5 s; no loader, no text. The loader only exists inside the conversation list, which isn't rendered until there is at least one message. For later answers the loader does appear (sparkle under the answer).
- Evidence: `screens-ui-run-1/create-390-thinking.png` vs `create-390-answer-thinking.png`.
- Suspected code: `apps/web/src/modules/director/pages/create.tsx` (`messages.length === 0` branch renders only the disabled button; `Conversation` with `thinking` is in the other branch).

### UI1-16 After Director's reply, the answer field sits under the fixed "Write my shots" bar
- Severity: minor. Category: UX / responsive.
- Viewport: 390x844 (worse at 360x740 and in landscape).
- Where: /create, conversation with Director.
- Steps: talk it through, answer once; wait for the second question.
- Expected: the view scrolls so the new question and the answer field are fully visible above the bottom bar.
- Actual: the reply grows the list; the "Type your answer" field and the mic/send buttons end up behind the gradient of the fixed red bar (only their top half shows). Nothing scrolls into view; on a phone with the keyboard closed the member has to find the field.
- Evidence: `screens-ui-run-1/create-390-answer-reply.png`.
- Suspected code: `apps/web/src/modules/director/pages/create.tsx` (no `scrollIntoView` on new turns; `fixed inset-x-0 bottom-0` bar).

### UI1-17 Your-shots editor: bad values are thrown away silently; delete has no confirm or undo
- Severity: minor. Category: UX.
- Viewport: 390.
- Where: /create/BA1mDsjg5Iw, each shot's "Seconds", "What happens", and the trash button.
- Steps: (a) set Seconds to 0, 999 or -3 and leave the field; (b) clear "What happens"; (c) tap the trash icon on a shot.
- Expected: (a) a message saying the allowed range (1-60 s); (b) the field marked with why "Save changes" is off; (c) a confirm or an undo toast (a whole shot and its text are gone).
- Actual: (a) the value snaps back to 5 with no message; (b) the bottom button turns into a greyed "Save changes" with no reason shown anywhere; (c) the shot is removed instantly with no way back except re-typing it.
- Evidence: `screens-ui-run-1/created-390-sec0.png`, `created-390-emptywhat.png`.
- Suspected code: `apps/web/src/modules/director/pages/created.tsx`.

### UI1-18 Your-shots: shot thumbnails are empty gradients and "Where" text is cut off mid-word
- Severity: polish. Category: UI.
- Viewport: 390.
- Where: /create/BA1mDsjg5Iw shot cards.
- Steps: open a freshly written template.
- Expected: a storyboard or a clear "drawing your storyboard" placeholder; long "Where" text fully visible or the field grows.
- Actual: every card has a plain purple gradient box (no image, no label) on the left; the 2-row "Where" textarea cuts "At the window ledge or table by the window with your French press" at "French / pre" with no scroll hint.
- Evidence: `screens-ui-run-1/created-390-00.png`.
- Suspected code: `apps/web/src/modules/director/pages/created.tsx` (fixed `rows`), storyboard slot component.

### UI1-19 Production returned 502 on "Talk it through" once
- Severity: minor. Category: functional (reliability).
- Where: `POST /rpc/director/brainstorm`.
- Steps: /create, idea + one photo, "Talk it through" (third call in ~6 minutes).
- Expected: 200 within a few seconds.
- Actual: one 502 with an empty body (the next two attempts, a minute later, were 200 in 5.4 s). The UI showed the generic "Something went wrong on our side" (checked by forcing a 502).
- Evidence: run log `RESP 502 /rpc/director/brainstorm` at ~22:40 UTC.
- Suspected code: API / ai service upstream timeout; worth a look in the logs for that minute.

### Shoot screen (/director/22k0fZarxh8/shoot)
Three Live sessions in total, all at 390x844 in Chrome with the fake camera (a green test pattern) and fake mic (a beep): 92 s, 29 s and 105 s, all on the shared demo account. Working: the start card explains recording and the permission prompt before it comes; camera preview 14 ms after the tap (fake device); "Director's joining..." pill then "Director"; the shot card; Tell Director (typed "can you hear me?" got "Yeah I can hear you! Ready when you are." in ~8 s); flip; the 3-2-1 countdown with "Cancel the countdown"; REC 00:01 pill and teleprompter while recording; "Go again" / "Keep it" review; the take uploaded (createUpload, PUT, completeUpload, ready in ~5 s) and reached the editor with a score and a note. No sideways scroll; every shoot control is 44 px or larger. Memory over 105 s: JS heap 9.2-15.1 MB, flat; DOM nodes 385 -> 515 then flat; listeners 439 -> 578 flat. No leak seen.
Note for the controller: I started these at about 22:50-22:58 UTC; none used the continuous roll (see UI1-20).

### UI1-20 Shared demo account: the start card promises continuous recording, then the roll is refused and the screen silently falls back to take-by-take
- Severity: major. Category: functional / UX.
- Viewport: 390 (any).
- Where: /director/22k0fZarxh8/shoot, "Let's shoot this together" card and what follows; `POST /rpc/recording/start` -> 403 `DEMO_ACCOUNT_LOCKED`.
- Steps: sign in with the shared demo account (what every visitor gets when the guest demo can't start), open any template, "Let's shoot", "Start shooting".
- Expected: the card describes what will actually happen on this account, or the roll works; if a feature is off for the shared account, say so once in plain words.
- Actual: the card says "Director records the whole time you're shooting, chat included, so it can find your best moments... Pause any time." The roll request gets 403 `DEMO_ACCOUNT_LOCKED`, nothing is shown, and the screen is the older shutter flow (red "Record a take" button, no REC indicator, no pause). The consent text is wrong for this account and the member never learns why the experience differs from what they were told.
- Evidence: `screens-ui-run-1/shoot-p390-00-start.png` then `shoot-p390-10-live.png`; console `403 POST /rpc/recording/start` in all three sessions; body `{"code":"DEMO_ACCOUNT_LOCKED"}`.
- Suspected code: `apps/web/src/modules/director/pages/shoot.tsx` (`StartCard` picks `intro.rollFirst` before the roll is known to be allowed) and `hooks/use-roll.ts` (swallows the start error).

### UI1-21 Director describes things that aren't in the picture (the camera showed a flat green test pattern)
- Severity: major. Category: functional (grounding). Logged because I saw it; the Live scripts are the other tester's.
- Where: shoot screen captions, sessions 1 and 2.
- Steps: start a shoot with a camera that shows no person and no street (Chrome fake camera); answer nothing; tap flip.
- Expected: Director says it can't see the member or the place (quality bar slice 11: "nothing is drawn for the fridge and Director says so").
- Actual: "Is that bustling market behind you where you want to film?", then after flip "Great, the back camera's on, and I can see a busy street behind you now.", and in session 2 after a take of the green pattern: "Your expression was really natural there." It repeats the plan's setting as if it saw it. (The take review itself was honest: 30/100, "next time film yourself on camera in the market".)
- Evidence: captions in the run log (aria-live text), `screens-ui-run-1/shoot-p390-15-live.png`..`-17-live.png`.
- Suspected code: Live system prompt / relay notes (apps/api live module); not web.

### UI1-22 Three idle nudges in about 25 seconds
- Severity: minor. Category: UX (tone). Other tester's area; logged as seen.
- Where: shoot screen, session 1, after Director's first question.
- Steps: start a shoot; don't answer (the fake mic plays a beep).
- Expected: one nudge at about 15 s, a second at most (slice 2).
- Actual: "Still there?", "Still there? No rush.", "I'll wait whenever you're ready; just say the word." in ~25 s, before any typed message.
- Evidence: run log captions at 25.1 s, 33.2 s, 41.5 s; `shoot-p390-10-live.png`, `-11-live.png`.
- Related: L8 (nudges and pending tool calls).

### UI1-23 Tapping ✕ during a take stops the take before you answer; "Stay" leaves you with the cut-short take
- Severity: minor. Category: UX.
- Viewport: 390.
- Where: shoot screen, "Leave the shoot" (✕) while REC is running.
- Steps: start a take on a 5.3 s shot; at about 2 s tap ✕; tap "Stay".
- Expected: the dialog appears over the running take; Stay carries on recording (quality bar: "Stay keeps the take").
- Actual: the take stops the moment ✕ is tapped (the dialog sits over the blurred "Your take" review), Stay drops you into review of a ~1-2 s take, and that take went to the editor as the only take of shot 1 ("Intro in the Market 1 s"; its column is so narrow the title truncates to "Intro in ...").
- Evidence: `screens-ui-run-1/shoot3-leave-during-take.png`, `edit-p390-state.png`.
- Related: U8 (short takes reach the editor).
- Suspected code: `apps/web/src/modules/director/hooks/use-leave-guard.ts` (`halt()` runs before asking) and the ✕ handler in `pages/shoot.tsx`.

### UI1-24 The shot card cuts the line to say at two lines with no way to read the rest
- Severity: minor. Category: UX.
- Viewport: 390 (worse at 360).
- Where: shoot screen before recording, shot card "Say" row.
- Steps: open the shoot screen on a shot with a long line.
- Expected: the full line (it's what the member must say), or a tap to expand.
- Actual: "“While traveling around India, I've noticed four variations of the head nod, and it is a..." with an ellipsis and nothing to tap; the full line only shows once recording starts (teleprompter).
- Evidence: `screens-ui-run-1/shoot-p390-02.png`.
- Suspected code: `apps/web/src/modules/director/components/shoot-parts.tsx` (line-clamp on the card).

### Editor (/director/22k0fZarxh8/edit)
Working at 390: Play/Pause with a running timecode, playback through unfilmed shots ("Shot 3 isn't filmed yet"), "Play from shot N", Captions panel (Pop / Classic / Off as pressed buttons, preview updates), Sound panel ("Keep your voice in the short"), Undo/Redo (enable and disable correctly), the take tile (radio, score, "Director's pick"), the yellow note with "Retake", gap tiles "Not filmed yet / Film it" (links back to the shoot with `back=edit`), "Save video" disabled while shots are missing with "9 shots still to film." above the board. Desktop 1280 has two panes as the quality bar asks. v1.6.0 has no Tell-Director bar in the editor (it landed after v1.6.0 in #35), and the asset picker lives on the template page.

### UI1-25 Editor in landscape: the preview player collapses to a dot
- Severity: major. Category: responsive.
- Viewport: 844x390 (phone landscape). Fine at 768x1024 and 1280.
- Where: /director/22k0fZarxh8/edit.
- Steps: open the editor on a phone and turn it sideways.
- Expected: a usable preview (two panes side by side, or the board below a reasonable player); quality bar: landscape keeps controls usable.
- Actual: the header, the transport row and the board (fixed `h-[42dvh] min-h-64`) take all the height; the video shrinks to a ~6x12 px green dot under the title. The board itself is fine.
- Evidence: `screens-ui-run-1/edit-land-state.png`.
- Suspected code: `apps/web/src/modules/director/pages/edit.tsx` (board `h-[42dvh] min-h-64` plus a flex-1 player with no min height; the two-pane layout only kicks in at `lg`).

### UI1-26 Editor choices vanish on reload and leaving with unsaved changes doesn't ask
- Severity: major (confirms F11, adds the missing guard). Category: functional / UX.
- Viewport: 390.
- Where: /director/22k0fZarxh8/edit, Captions and Sound panels; the ✕ (Back) link.
- Steps: switch captions to Classic and turn "Keep your voice" off; reload. Separately: change the caption style and tap ✕.
- Expected: choices persist (or at least ask before they're thrown away); quality bar: "with unsaved changes, dismissing asks first"; "Nothing is lost on failure: edits persist".
- Actual: after reload the voice switch is back on and captions are back to the default; tapping ✕ with a change goes straight to the template page, no dialog, no beforeunload.
- Evidence: run log `after reload voice: true`, `back with unsaved change -> /director/22k0fZarxh8 dialog: null alertdialogs: 0`.
- Suspected code: `apps/web/src/modules/director/hooks/use-edit-history.ts` (useState only), `pages/edit.tsx` header link.

### UI1-27 Editor tap targets under 44 px
- Severity: minor. Category: a11y / responsive.
- Viewport: 390x844.
- Where: /director/22k0fZarxh8/edit.
- Actual (measured): ✕ Back 40x40, Save video 122x40, Play 40x40, Captions 40x40, Sound 40x40, Undo 40x40, Redo 40x40, "Film it" 60x28 (x9), "Retake" 85x29, the take radio's input 20x20, the voice switch ~20x20 (a native red checkbox, not a switch).
- Expected: 44x44 (HIG) / 48x48 (Material).
- Suspected code: `apps/web/src/modules/director/pages/edit.tsx`, `components/shot-board.tsx`, `components/edit-tools.tsx`.

### UI1-28 Short takes make board columns too narrow: titles truncate and "Director's pick" spills out of the tile
- Severity: polish. Category: UI.
- Viewport: 1280x800 and 390.
- Where: /director/22k0fZarxh8/edit, shot 1 column (a 1 s take).
- Actual: the column width follows the take length, so the header reads "Intro in ...", the yellow note wraps to one or two words per line (13 lines at 390), and the take tile's "Director's pick" runs past the tile's right edge (cut off at "Director").
- Evidence: `screens-ui-run-1/edit-d1280-state.png`, `edit-p390-state.png`.
- Suspected code: `apps/web/src/modules/director/components/shot-board.tsx` (min column width).

### UI1-29 A created "no talking" template says "You, talking to the camera"; storyboards still missing 15 minutes later with no status
- Severity: minor. Category: UX (content / loading state).
- Viewport: 390.
- Where: /director/BA1mDsjg5Iw (made in /create from "20 seconds of my morning coffee, cosy, no talking").
- Steps: create a template from a no-talking brief; open its page.
- Expected: "What you'll need" reflects the brief (no talking: hands, props, the window); a storyboard placeholder that says it's still being drawn, or the image.
- Actual: "You, talking to the camera / About 2 minutes" for a 20-second no-talking reel; the hero strip shows two drawings, one black tile and one plain purple gradient; shots 3 and 4 have empty storyboard boxes with only the green "where you stand" outline; no "drawing" status anywhere, ~15 minutes after creation. Library calls this template one of "7 Shorts" though it isn't a Short.
- Evidence: `screens-ui-run-1/own-tpl-390-00.png`, `own-tpl-390-02.png`.
- Suspected code: `apps/web/src/modules/director/components/what-you-need.tsx` (needs derived from a default, not the brief); storyboard placeholders in `components/shot-list.tsx`; `library.count` string.

### Account and settings (/settings, /settings/security, user menu)
Working: avatar button opens a menu (name + email, Settings, Sign out); the theme button opens Light / Dark / System; on the shared demo, saving a name gets a clear red toast ("The demo's settings can't be changed. Create your own account for that.") and the name is unchanged after reload; Security shows "Confirm it's you / Sign in again" instead of the device list (list-sessions 403).

### UI1-30 Shared demo: every account control is live and only fails after you use it (the avatar is uploaded first, then refused)
- Severity: minor. Category: UX.
- Viewport: 390.
- Where: /settings (Name + Save, Language, Time zone, "Upload a picture", "Change email"), /settings/security (2-step, passkey, password, "Delete my account").
- Steps: sign in with the shared demo account; edit the name and Save; upload a picture.
- Expected: the demo card already says "publishing and account changes are off", so the controls are disabled with that note at the top (or hidden), and nothing is uploaded.
- Actual: all fields and buttons are enabled. Save fails with a toast. "Upload a picture" goes through createUpload, the PUT to Cloud Storage, completeUpload and a scan ("Checking your picture...") and only then `setAvatar` returns 403 `DEMO_ACCOUNT_LOCKED` ("The demo can't do that. Create your own account to publish and change settings."). The uploaded file is left in storage (see S4). "Delete my account" and "Change password" are offered too.
- Evidence: `screens-ui-run-1/settings-390-save-name.png`, `settings-390-avatar.png`; responses `403 /api/auth/update-user`, `403 /rpc/user/setAvatar`.
- Suspected code: `apps/web/src/modules/settings/components/*-card.tsx` (no demo-account read-only state); `avatar-card.tsx` uploads before checking.

### Landing, sign-in, sign-up, forgot password, legal (signed out)
Working: "See how it works" jumps to `#how`; the hero conversation's pause toggles (`aria-pressed`); "Play “4 Variations...”" plays the original inline with the shot list; each template card goes to `/sign-in?demo=1&next=/director/<id>`; "Go home" on the 404 goes to `/`; the theme menu (Light / Dark / System) works on public pages; sign-in shows inline errors on empty submit ("Enter a valid email address", "Required") and a toast for wrong credentials ("That email and password don't match."); sign-up and forgot-password keep their submit disabled until filled. No sideways scroll on any public page at any of the seven sizes.

### UI1-31 Privacy policy and terms are template placeholders ("Replace this text with your own policy before launch")
- Severity: blocker (for a public product that records camera and microphone). Category: functional (content / legal).
- Viewport: all.
- Where: https://director.mmadan.in/privacy and /terms (linked from every footer).
- Steps: open /privacy.
- Expected: quality bar, privacy section: "The privacy page says what's recorded, where it's kept, for how long, and that Google doesn't train on it under Vertex AI's terms."
- Actual: the whole privacy page is "This policy explains what data we collect and why. Replace this text with your own policy before launch." (153 characters); terms: "These terms govern your use of this service. Replace this text with your own terms before launch." Meanwhile the shoot start card says Director records "the whole time you're shooting, chat included".
- Evidence: `screens-ui-run-1/legal-390-privacy.png`; run log text.
- Suspected code: `apps/web/src/modules/marketing/pages/legal.tsx` and the `legal.*` strings in `packages/i18n`.

### UI1-32 Demo fallback on sign-in: "Welcome back", two stacked alerts, and "Use demo account" that doesn't sign you in
- Severity: minor. Category: UX.
- Viewport: 390 and 360.
- Where: /sign-in?demo=1 when the guest demo can't start (Turnstile not passed; seen every time in automated Chrome, and what a visitor with a strict blocker gets).
- Steps: tap "Try it now, no sign-up" on the landing page; wait.
- Expected: one clear path, ideally one tap ("Continue with the shared demo") that signs in.
- Actual: the card is titled "Welcome back / Sign in with your email and password." for someone who never had an account; an alert says the own demo couldn't start; a second red alert below the Turnstile box says "The security check couldn't load..."; "Use demo account" only fills the form that is already filled; the visitor has to find "Sign in" below the Google button. The shared password is shown in plain text, and at 360 the email wraps mid-word ("demo@director.mmadan.i / n").
- Evidence: `screens-ui-run-1/signin-demo-fallback-390.png`, `sweep-library-p360.png` (that file shows the signed-out redirect to sign-in at 360).
- Suspected code: `apps/web/src/modules/auth/components/demo-account.tsx` (`DemoAccountCard` `onUse` only resets the form; `break-all` on the email), `pages/sign-in.tsx` (title).

### UI1-33 "Continue with Google, to post to your channel" overflows its button at 360 px
- Severity: minor. Category: responsive.
- Viewport: 360x740.
- Where: /sign-in, /sign-up.
- Steps: open /sign-in at 360 px.
- Expected: the label wraps or shortens inside the button.
- Actual: the text is wider than the 312 px button; it runs past both rounded edges ("Continue with Google, to post to your channel" with the C and the l outside the border).
- Evidence: `screens-ui-run-1/sweep-library-p360.png` (bottom).
- Suspected code: `apps/web/src/modules/auth/pages/sign-in.tsx` (outline `Button` is `whitespace-nowrap` in `packages/ui/src/components/button.tsx`).

### UI1-34 Turnstile widget is always light, on dark pages too
- Severity: polish. Category: UI.
- Where: /sign-in, /sign-up, /settings (email card) in the dark theme.
- Actual: a white "Verify you are human" box in the middle of a dark card.
- Evidence: `screens-ui-run-1/signin-390-empty-submit.png`, `signup-390.png`.
- Suspected code: `apps/web/src/components/captcha.tsx` (pass `theme: "auto"` or the app theme).

### Accessibility pass
axe-core 4.x (wcag2a/aa, 21a/aa, 22aa, best-practice) on 16 screens at 390 and 1280: only `page-has-heading-one` on /sign-in, /sign-up, /forgot-password (below). Static axe can't see the live shoot, dialogs or captions over video. Keyboard: Tab through every screen at 1280; no traps (YouTube's iframe takes 13 stops, Turnstile 4, both come back out). Reduced motion: with `prefers-reduced-motion: reduce` the landing hero's six CSS animations (chat bubbles, before/after, REC pulse) all stop; no running animations on library, template or shoot either way. Visible focus rings on all controls except those noted.

### UI1-35 No skip link and no `<h1>` on the auth pages
- Severity: minor. Category: a11y.
- Viewport: all.
- Where: every page (no "Skip to content" as the first Tab stop: it's always the "Director" logo, then nav, theme, avatar); /sign-in, /sign-up, /forgot-password have no `h1` (the card title "Welcome back" / "Create your account" / "Reset your password" is a `div`).
- Steps: load a page, press Tab once; run axe on /sign-in.
- Expected: a skip link to `main`; one `h1` per page.
- Actual: 5 header stops before the content on every signed-in page; axe `page-has-heading-one` (moderate) on the three auth pages.
- Suspected code: `apps/web/src/modules/shell/components/site-header.tsx` / `site-chrome.tsx`; `apps/web/src/modules/auth/components/auth-card.tsx` (CardTitle renders a div).

### UI1-36 Your-shots editor: focused fields go under the fixed "Looks good, let's shoot" bar
- Severity: minor. Category: a11y (WCAG 2.2 2.4.11 Focus Not Obscured) / responsive.
- Viewport: 1280x800 (worse on phones with the keyboard up).
- Where: /create/BA1mDsjg5Iw.
- Steps: Tab through the shot cards.
- Expected: the focused field scrolls clear of the fixed bottom bar.
- Actual: shot 2's "Where", shot 3's "Seconds", shot 4's "Move up" and "Delete" receive focus while covered by the fixed CTA (`elementFromPoint` at their centre is the CTA link).
- Evidence: keyboard run log (`[COVERED by A.mx-auto flex w-full max-w-lg ...]`).
- Suspected code: `apps/web/src/modules/director/pages/created.tsx` (needs `scroll-padding-bottom`/`scroll-margin` equal to the bar).

### UI1-37 Template page: the primary action is ~45 Tab stops away; landing "Play" has no focus ring
- Severity: minor. Category: a11y.
- Viewport: 1280.
- Where: /director/22k0fZarxh8 ("Let's shoot"), / ("Play “4 Variations of the Indian Head Nod”").
- Steps: Tab from the top of the template page; Tab to the Play button on the landing page.
- Expected: the main action reachable early (it's visually pinned at the bottom of every screen); a visible focus indicator on every control.
- Actual: "Let's shoot" comes after the YouTube player's 13 stops, 10 strip buttons, the speech choice and 20 shot-card buttons (not reached in 45 Tabs). The landing Play button shows no outline or ring when focused.
- Suspected code: `apps/web/src/modules/director/pages/director.tsx` (DOM order of the fixed CTA); `apps/web/src/modules/marketing/components/original-player.tsx`.

### Performance
Method: Chrome 140 headless, 390x844 DPR 3 mobile, CDP `Emulation.setCPUThrottlingRate 4` and Lighthouse's slow-4G (562.5 ms RTT, 1.47 Mbps down, 0.68 Mbps up), cold cache per page; LCP/CLS/long tasks from PerformanceObserver; TBT = sum(long task - 50 ms) after FCP; INP = worst event duration of one scripted interaction per page (typing or a tap); JS = same-origin script transfer. My machine is in India and the site is served through Cloudflare's SIN edge, so TTFB includes the trip to the origin.

| Page | TTFB | FCP | LCP | CLS | TBT | max long task | INP (action) | JS kB (gz) / decoded | Requests |
|---|---|---|---|---|---|---|---|---|---|
| / | 1417 | 4488 | **4488** | 0 | 341 | 145 | 160 (theme menu) | 326 / 1020 | 36 |
| /sign-in | 682 | 3588 | **6580** | **0.426** | 316 | 295 | 104 (typing) | 356 / 1103 | 42 |
| /library | 1083 | 3676 | **5780** | 0.001 | 205 | 249 | 64 (typing) | 354 / 1101 | 47 |
| /director/<id> | 800 | 3568 | **6752** | 0 | 115 | 94 | 128 (audio choice) | 373 / 1158 | 40 |
| /director/<id>/edit | 1203 | 4060 | **11860** | 0 | **1262** | **751** | 184 (Captions) | 362 / 1122 | 43 |
| /create | 645 | 3340 | **5572** | 0 | 341 | 256 | 168 (typing) | 335 / 1046 | 31 |
| /media | 706 | 3632 | **6504** | 0.001 | 573 | 333 | **272** (theme menu) | 353 / 1098 | 35 |
| /settings | 738 | 3644 | **5856** | **0.105** | 121 | 112 | 72 (typing) | 373 / 1151 | 44 |
| /director/<id>/shoot | 1156 | 3684 | 7112 | 0 | 68 | 93 | n/a | 377 / 1166 | 34 |

Scroll at 4x CPU (rAF over 4 s of scrolling): landing, library, template and the editor's shot board all held 60 fps (0 frames over 34 ms, worst 33 ms on the template page, no long tasks). Shoot screen memory: flat over 92 s and 105 s Live sessions (heap 9-15 MB, nodes ~515, listeners ~578). Every route's first-load JS is under the repo's 410 kB route budget (`scripts/bundle-budget.ts`), but each page ships ~1.1 MB of decoded JS, which is where the TBT comes from on a 4x-slower phone. Fonts and the two framework chunks take 3-3.7 s each on slow 4G and gate FCP everywhere. Static chunks are `immutable` and Cloudflare HITs; the HTML is `no-store`, `cf-cache-status: DYNAMIC`, TTFB 0.8-1.1 s on a plain fast connection (`curl` x5).

### UI1-38 LCP is over the 2.5 s target on every page on a mid-range phone on 4G
- Severity: major. Category: performance.
- Viewport: 390x844, 4x CPU, slow 4G.
- Where: all pages (table above). Quality bar: LCP 2.5 s or less on landing, library and template.
- Actual: landing 4.5 s, library 5.8 s, template 6.8 s, create 5.6 s, my media 6.5 s; the editor 11.9 s.
- Evidence: table above; `perf-throttled.json` in the run scratchpad. Biggest contributors seen: HTML TTFB 0.7-1.4 s (dynamic, no edge cache), two preloaded variable fonts (Geist and Geist Mono, ~3.5 s each on slow 4G, both on the critical path although Mono is only used for timecodes), and two framework chunks (`18yj6r-qkayvn.js`, `2n78ittnq6lcw.js`, ~3.1-3.7 s).
- Suspected code: `apps/web/src/app/layout.tsx` (both fonts preloaded; Geist Mono could drop `preload`), the always-dynamic root (nonce CSP makes every page dynamic; the landing could be static).

### UI1-39 Editor: 1.3 s of main-thread blocking on load, a 751 ms long task, LCP 11.9 s
- Severity: major. Category: performance.
- Viewport: 390x844, 4x CPU.
- Where: /director/22k0fZarxh8/edit with one take.
- Steps: open the editor cold.
- Expected: quality bar "Editor interactive with ten takes: 3 s or less"; TBT well under 300 ms.
- Actual: TBT 1262 ms with 9 long tasks (worst 751 ms) and LCP at 11.9 s, with one 1 s take. Profile (4x CPU): top self time in chunk `12sliu6br0qzf.js` (192 ms; contains the canvas/`measureText`/MediaRecorder/webm caption-and-stitch code) and `2r7br6nbjbq1r.js` (190 ms; captions/canvas/AudioContext), plus 110 ms of module evaluation; the stitch and caption renderer run at load although nothing is playing or being saved.
- Suspected code: `apps/web/src/modules/director/lib/stitch.ts`, `components/caption-layer.tsx`, `pages/edit.tsx` (import the export pipeline lazily, on Save).

### UI1-40 Sign-in jumps twice while it loads (CLS 0.43); settings jumps once (CLS 0.11)
- Severity: major (sign-in), minor (settings). Category: performance / UX.
- Viewport: 390x844, 4x CPU.
- Where: /sign-in (and /sign-up); /settings.
- Steps: open /sign-in signed out; watch the Email field.
- Expected: CLS 0.1 or less; the form stays put.
- Actual: at ~3.4 s the demo card appears above the form and pushes Email/Password/Sign in down 250 px (0.147); at ~6.2 s the Turnstile widget mounts and pushes everything another 70 px (0.179). Someone already typing their email gets the field moved from under their thumb. On /settings the Email card grows by 280 px when its Turnstile/notice loads (0.106).
- Evidence: layout-shift sources from the run: `Email y 207->457`, then `Email y 457->527`; settings `Email card y 516->796`.
- Suspected code: `apps/web/src/modules/auth/components/demo-account.tsx` (renders nothing until `system.info` arrives; reserve its space or render a skeleton), `apps/web/src/components/captcha.tsx` (reserve 65 px), `apps/web/src/modules/settings/components/email-card.tsx`.

### UI1-41 Opening the theme menu on My media takes 272 ms (INP)
- Severity: minor. Category: performance.
- Viewport: 390x844, 4x CPU.
- Where: /media, header "Toggle theme".
- Actual: 272 ms from tap to paint (target 200 ms); 160 ms on the landing page, 184 ms for "Captions" in the editor, 168 ms typing the first letter in /create.
- Suspected code: shared header dropdown (`apps/web/src/modules/shell/components/theme-toggle.tsx`) rendering under a busy main thread; /media has 573 ms TBT on load.

### Asset picker and the asset Shorts
None of the six starter templates has a pickable asset, so to reach the picker I signed in a private guest (headed Chrome passes Turnstile) and pasted OvRozQobeuI (the chart Short from UAT slices 9-10; not seeded in production). The asset picker could not be reached: see UI1-42. Stock is also off in production (`system.info features.stock: false`). Publish sheet: needs a saved video in My media; both demo accounts had none, saving needs every shot filmed, and I'd used my three Live sessions, so I could not open it. Not covered: asset picker tabs (upload, stock, create with AI), publish sheet.

### UI1-42 Indexing the chart Short (OvRozQobeuI) gives a plan with no assets, so the asset picker never appears
- Severity: major. Category: functional.
- Viewport: 390.
- Where: guest account, /library paste "https://www.youtube.com/shorts/OvRozQobeuI" -> /director/OvRozQobeuI.
- Steps: index the Short; open its template page.
- Expected: (slices 9 and 10) "What you'll need" lists the chart as a slot with "Change" that opens the asset picker; shot 1 shows the chart as a guide in the bottom half; shot 2 (the call-to-action card) is an image/card shot.
- Actual: `plan.assets` is `[]`; "What you'll need" only says "You, talking to the camera / About 3 minutes"; "You need 2 shots: 2 videos and no photos"; shot 2 "App Call to Action Card" is a video shot with "Where: Use a clean digital graphic or screen recording... Back camera"; shot 1's framing says "leaving the bottom two-thirds for the graphic overlay" with no graphic anywhere. Also "The original audio couldn't be fetched, so your mic will be used." (`audio.status: failed`), and no storyboard images.
- Evidence: `screens-ui-run-1/asset-tpl-390-top.png`, `asset-tpl-390-needs.png`; `/rpc/director/plan` -> `assets: [], shots[*].kind: "video", audio.status: "failed"`.
- Suspected code: the indexer prompt / plan schema in apps/ai (asset detection), not web.

### UI1-43 Indexing says "This takes about a minute" and took about three, with no "still working" update
- Severity: minor. Category: UX (loading state).
- Where: /library index card and the "Yours / Gemini is watching the Short / New Short" library card.
- Steps: paste a new Short; wait.
- Expected: an honest estimate; quality bar: anything over 10 s says it's still working.
- Actual: the stepper (Queued, Watching, Writing shots, Ready) sat on "Gemini is watching the Short" for ~2.5 minutes with the same copy; the card title was "New Short" all along.
- Evidence: `screens-ui-run-1/guest-index-progress.png`, `guest-yours-card-indexing.png`; run log 0 s -> 109 s polling the card, plus ~60 s before.
- Suspected code: `apps/web/src/modules/director/components/index-progress.tsx`, `template-card.tsx`.

### UI1-44 Guest account shows its internal address "guest-<uuid>@guest.invalid" in the account menu
- Severity: polish. Category: UI (copy).
- Where: any signed-in page as a private guest, avatar "G" menu.
- Expected: "Guest" plus something useful ("Your demo is deleted after a day", or a "Create your account" link).
- Actual: "Guest / guest-501972cd-d266-47c0-a788-d8c0d97a9e02@guest.invalid / Settings / Sign out"; nothing in the app (menu, settings, library) tells the guest their footage is deleted after a day, which only the sign-in card says.
- Suspected code: `apps/web/src/modules/shell/components/user-menu.tsx`.

### Deep links, back button, reload
Working: browser back from shoot -> template -> library (library restores its scroll position); forward works; signed-out deep links go to sign-in with `next`; a template not in your library ("/director/OvRozQobeuI" on the shared account) says "This Short isn't in your library yet. / Go to the library" (good); `/shorts/<id>` redirects to `/director/<id>`; editor and created-template edits persist on reload where they are saved server-side (shot order, UI1-17).

### UI1-45 Shoot screen before "Start shooting" has no way out: no ✕, no back, no title
- Severity: major. Category: UX (dead end).
- Viewport: all; worst when installed to the home screen (`manifest display: standalone` has no browser back button).
- Where: /director/<id>/shoot (every entry: "Let's shoot", the editor's "Film it", a shared link).
- Steps: open the shoot screen; decide not to start.
- Expected: a ✕ or back control in the top corner (the started shoot has "Leave the shoot"), and a hint of which shot this is.
- Actual: a black screen with the "Let's shoot this together" card and "Start shooting", nothing else; the only exit is the browser/OS back gesture. Coming from the editor's "Film it" there's no visible way back to the editor.
- Evidence: `screens-ui-run-1/deep-_director_22k0fZarxh8_shoot_shot_99_audio_voice.png`, `shoot-p390-00-start.png`; keyboard pass: the page has exactly 1 Tab stop.
- Suspected code: `apps/web/src/modules/director/pages/shoot.tsx` (`StartCard` phase renders no header).

### UI1-46 Shoot links accept any shot number; bad template ids in /create show "Some fields need attention"
- Severity: minor. Category: UX (deep links / error state).
- Where: `/director/22k0fZarxh8/shoot?shot=99`, `?shot=-1`, `?shot=abc&audio=zzz`; `/create/doesnotexist`; `/create/22k0fZarxh8`.
- Steps: open each.
- Expected: out-of-range shots clamp or say so; a missing created template says it can't be found; `/create/<starter id>` doesn't offer to rewrite a starter.
- Actual: all three shoot links show the same start card with no sign which shot will be filmed (10 shots exist; 99 doesn't). `/create/doesnotexist` (422) shows "Your shots / Some fields need attention. / Nothing was used up. Try describing it again." `/create/22k0fZarxh8` opens the "Your shots" editor for the starter template with move/delete/edit controls and "Looks good, let's shoot" (I didn't save).
- Evidence: `screens-ui-run-1/deep-_create_doesnotexist.png`, `deep-_create_22k0fZarxh8.png`, run log.
- Suspected code: `apps/web/src/app/(app)/director/[videoId]/shoot/page.tsx` (param parsing), `apps/web/src/modules/director/pages/created.tsx` (no `source === "created"` check), error mapping as in UI1-09.

### UI1-47 At 200% text size the app scrolls sideways and clips text on most screens; the shoot card's text doesn't scale at all
- Severity: major. Category: a11y / responsive.
- Viewport: 390x844 with Chrome's default font size at 32 px (`Page.setFontSizes`, the same as Android Chrome's 200% text scaling).
- Where: /library (page 751 px wide in a 390 px viewport), /director/<id> (569 px), /media and /settings (610 px), /director/<id>/edit, /director/<id>/shoot.
- Steps: set browser text size to 200%; open each screen.
- Expected: quality bar: "at 200% browser text size, nothing is clipped, overlaps or needs horizontal scrolling".
- Actual: the header nav ("Library", "My media") is pushed off the right edge on every signed-in page and drags the page sideways; on the library the heading reads "Shoot your ow", every card is cut; on the template page the speech choice row ("I'll speak / Use the original audio") forces 569 px; in the editor the transport row wraps "00:00 / 00:31" onto three lines, the shot titles truncate to "1 I." and the yellow note clips mid-word ("graphi"); on the shoot screen the start card's body copy stays at its fixed 15 px (`text-[15px]`) while the title doubles, so the consent text, the most important text on that screen, doesn't scale.
- Evidence: `screens-ui-run-1/text200_library.png`, `text200_director_22k0fZarxh8.png`, `text200_director_22k0fZarxh8_edit.png`, `text200_director_22k0fZarxh8_shoot_shot_0_audio_voice.png`, `text200_settings.png`.
- Suspected code: `apps/web/src/modules/shell/components/site-header.tsx` (no wrap/collapse), `pages/director.tsx` speech fieldset (`flex gap-2` without wrap), `pages/shoot.tsx` (`text-[15px]` and other px sizes), `pages/edit.tsx` transport row.

### UI1-48 Header and footer controls are under 44 px on every page
- Severity: minor. Category: a11y / responsive.
- Viewport: 360-430 phones.
- Where: site header and footer on landing, auth, library, media, settings, 404.
- Actual (measured at 390): theme toggle 32x32, avatar button 32x32, "Sign in" 63x28, nav tabs 70x29 / 88x29, "Director" logo link 79x25, landing CTAs "Try it now, no sign-up" 164x36 and "See how it works" 133x36, footer "Terms of service" / "Privacy policy" 20 px tall, auth buttons and inputs 32 px tall (326x32), settings tabs "Profile" 41x30 / "Security" 55x30, "Sign in again" 100x28, "Create account" link 99x17.
- Expected: 44x44 pt (HIG) / 48x48 dp (Material).
- Evidence: audit output in run logs (`small` lists) for each sweep.
- Suspected code: `packages/ui/src/components/button.tsx` default `h-8` size, `apps/web/src/modules/shell/components/*`.

### UI1-49 Index-limit dialog is titled "You've used your AI credit"
- Severity: minor. Category: UX (copy).
- Viewport: 390.
- Where: /library on an account that has indexed its one Short; paste any new Short link and tap "Index it" (409 `DIRECTOR_INDEX_LIMIT`).
- Expected: quality bar, tone of voice: 'no "AI credit"'; plain words ("You've added your Short").
- Actual: title "You've used your AI credit". The rest works: it lists the six starters with thumbnails, focus moves into the dialog and Escape returns it to the link field. The dialog is white over the dark studio page, unlike the dark sheets elsewhere.
- Evidence: `screens-ui-run-1/credit-dialog-390.png`.
- Suspected code: `apps/web/src/modules/director/components/credit-dialog.tsx`, `library.credit.*` in `packages/i18n/messages/en.json`.

### UI1-50 Landing hero mock: the "REC 01:12" pill wraps onto two lines on phones
- Severity: polish. Category: UI.
- Viewport: 360, 390, 430 and 768.
- Where: / hero phone mock, top right.
- Actual: "REC" and "01:12" stack in a tall pill next to "Where: the market", while on 1280 they sit on one line; it doesn't look like the real shoot screen's "REC 00:01" pill.
- Evidence: `screens-ui-run-1/landing-390-fold.png`, `sweep-home-t768.png`.
- Suspected code: `apps/web/src/modules/marketing/components/hero-loop.tsx` / `landing.css` (`whitespace-nowrap`).

### UI1-51 Phone in landscape: the shoot start card's title is cut off above the screen and the card is a narrow column
- Severity: minor. Category: responsive.
- Viewport: 844x390 (phone landscape). Fine at 1280 (though small and low on the screen).
- Where: /director/<id>/shoot, "Let's shoot this together" card.
- Steps: open the shoot screen with the phone sideways.
- Expected: the whole consent card readable (quality bar: landscape keeps controls usable), using the width.
- Actual: the card is pinned to the bottom (`absolute inset-x-4 bottom-...`, capped at the column width), its body wraps at ~190 px into 12 lines, and the heading "Let's shoot this" is above the top edge (only "together" shows); the page can't scroll to it.
- Evidence: `screens-ui-run-1/shoot-start-land.png`.
- Suspected code: `apps/web/src/modules/director/pages/shoot.tsx` `StartCard`.

### UI1-52 With the keyboard up, the fixed bottom bars on /create and "Your shots" take a fifth of what's left
- Severity: polish. Category: responsive.
- Viewport: 390 wide with a 420 px visible height (an Android keyboard open, emulated by resizing).
- Where: /create ("Write my shots"), /create/<id> ("Looks good, let's shoot").
- Actual: the focused field stays visible (good), but the 80 px gradient bar plus button covers the next control ("Add a photo" under "Write my shots"; the next card under "Looks good, let's shoot"), so the member types with ~260 px of page. Real keyboard behaviour on iOS Safari (which doesn't resize the layout viewport) still needs a device check.
- Evidence: `screens-ui-run-1/create-kbd-390x420.png`, `created-kbd-390x420.png`.
- Suspected code: `pages/create.tsx`, `pages/created.tsx` (hide the bar while an input has focus, or use `interactive-widget=resizes-content`).

### UI1-53 Editor controls have no hover state on a laptop (and the transport buttons use the arrow cursor)
- Severity: polish. Category: UI.
- Viewport: 1280x800, mouse.
- Where: /director/22k0fZarxh8/edit: Play, Captions, Sound, "Film it", "Retake", the "Play from shot N" headers; also "I'll speak / Use the original audio" on the template page.
- Steps: hover each control.
- Expected: a visible hover (the library's "Describe it", "My media" and template cards have one) and a pointer cursor.
- Actual: pixel-identical before and after hover (screenshot compare), and `cursor: default` on Play, Captions, Sound and the shot headers. On the library, the current nav tab ("Library") also doesn't react, which is fine for a current tab.
- Suspected code: `apps/web/src/modules/director/pages/edit.tsx` transport buttons, `components/shot-board.tsx`.

---

## Summary

53 issues: 1 blocker, 13 major, 29 minor, 10 polish.
By category: UX 17, UI 11, responsive 7, a11y 7, functional 7, performance 4.

Known issues confirmed along the way: F11 (editor choices lost on reload, in UI1-26), U8 (a 1 s take reached the editor, in UI1-23), F3 (unfilmed shots drawn as captioned gaps, in UI1-10), S2/S4 (shared demo uploads left in storage, in UI1-30), L8 (nudges, near UI1-22).

### Top 15
1. UI1-31 (blocker): /privacy and /terms are template placeholders ("Replace this text with your own policy before launch") on an app that records camera, mic and chat.
2. UI1-01 (major): the library scrolls sideways at 360 px and loses its right gutter at 390 px; every card is cut at the right edge.
3. UI1-20 (major): on the shared demo account the start card promises continuous recording, then `recording/start` returns 403 `DEMO_ACCOUNT_LOCKED` and the screen silently falls back to take-by-take.
4. UI1-45 (major): the shoot screen before "Start shooting" has no ✕ or back control, so it's a dead end when the app is installed (manifest `standalone`) or opened from the editor's "Film it".
5. UI1-26 (major, confirms F11): editor caption and sound choices are lost on reload, and ✕ with unsaved changes leaves without asking.
6. UI1-25 (major): in phone landscape the editor's preview shrinks to a dot.
7. UI1-47 (major): at 200% text size most screens scroll sideways (library 751 px wide) and the shoot consent text doesn't scale.
8. UI1-38 (major): LCP is 4.5-6.8 s on landing, library and template (target 2.5 s) on a 4x-slower phone over slow 4G; dynamic HTML TTFB 0.7-1.4 s, both fonts preloaded.
9. UI1-39 (major): the editor blocks the main thread for 1.3 s on load (one 751 ms task) and LCP is 11.9 s with one take; the export and caption code runs at load.
10. UI1-40 (major): sign-in jumps twice while loading (CLS 0.43) as the demo card and then Turnstile push the form 320 px down.
11. UI1-42 (major): indexing the chart Short (OvRozQobeuI) gives `assets: []`, so the asset picker never appears; its original audio also failed to fetch.
12. UI1-13 (major): about ten paste attempts on the shared demo, six of them only opening existing templates, lock indexing for every demo visitor for ~51 minutes ("Try again in 3,052 seconds").
13. UI1-09 (major): a bad template link shows "Some fields need attention." and a "Try again" that can never work.
14. UI1-21 (major): Director described "a bustling market" and "a busy street" behind a flat green test pattern, and praised the "expression" in it.
15. UI1-23 (minor, confirms U8): tapping ✕ during a take stops it before the Leave/Stay dialog, so "Stay" keeps a 1-2 s take.

### Not covered, and why
- Publish sheet: needs a saved video; neither demo account had one, saving needs every shot filmed, and I'd used my three Live sessions.
- Asset picker tabs (upload, stock, create with AI): no template in production has a pickable asset (UI1-42), and stock is off (`features.stock: false`).
- The Tell-Director bar and find-a-take in the editor: not in v1.6.0 (#35 landed after).
- Continuous roll (REC pill, pause/resume, Done): refused on the shared account (UI1-20); the guest account could run it, but I had no Live sessions left.
- Back gesture during a take, real on-screen keyboards, haptics, safe areas on a notched phone, VoiceOver/TalkBack: need a real device.

Notes for the other tester and the controller: my three Live sessions ran ~22:50-22:58 UTC on the shared demo account. I created "Cozy Window Coffee" (BA1mDsjg5Iw) on the shared account. A private guest (`guest-501972cd-...`) indexed OvRozQobeuI. The shared account's index rate limit was hit shortly before 22:40 UTC (expired since).
