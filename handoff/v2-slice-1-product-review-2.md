# Director v2, slice 1: product re-review (fix round)

Scope: the two majors and nine minors from `v2-slice-1-product-review.md`. Sources: the
engineer's "Review round 1" in `v2-slice-1-report.md`, the refreshed screenshots in
`v2-evidence/`, and the code on `origin/feat/mm/director-v2` (336ac42..655a6f4, rebased
onto master fd9ef09): `hooks/use-leave-guard.ts`, `components/director-captions.tsx`,
`lib/live.ts`, `pages/shoot.tsx`, `hooks/use-director-live.ts`,
`apps/api/src/modules/live/live.setup.ts`. Read only; no suites run.

## Verdict

**Ship slice 1 to production now, with UAT to follow.** Both majors are fixed and so are
the minors that were in scope. The fixes broke nothing that blocks release. Two new
minors and one thing for UAT to watch are listed below.

## The majors

| Issue | Verdict | Evidence |
|---|---|---|
| **1. ✕ during a take threw it away** | **Fixed** | `useLeaveGuard`: in setup ✕ leaves at once. In a countdown, recording or unkept review, ✕ first halts (calls off the count, or stops the recording) and asks "Leave? / This take isn't kept yet." with Leave and Stay; Stay keeps the take on review. Back is caught with an extra history entry while guarded, removed when the take is settled, and replaced (not stacked) when a kept take moves on. Three tests in `shoot.test.tsx`, including back; screenshot 07. |
| **2. Captions put the reply above what it answers** | **Fixed** | `lib/live.ts` keeps the last exchange in order, oldest first; the newest line sits nearest the text box (screenshots 03, 04, 08). The member's line clears 8 s after Director's finished answer, and at once on a flip, a countdown or a review: in 04 the kitchen line is gone after the flip. Screen readers get one live region that reads each finished line once ("Director says …", "You said …"), with the visual lines hidden from them. |

A note on screenshots 03 and 04: the Director bubble reading "You said: okay let me go
to the kitchen" is the mock Live stand-in echoing the member
(`packages/fake-google/src/live.ts` line 81), not a leak of the screen-reader text.

## The minors

| # | Issue | Verdict | Evidence |
|---|---|---|---|
| 1 | Director talks over the 3-2-1; held words shown later | **Fixed** | New take states `countdown` and `cancelled`, with relay notes ("Go quiet now…", "no take this time"). The voice is held from the first number (`quiet = countdown \|\| recording` in `shoot.tsx`), and Director transcripts are dropped while held (`use-director-live.ts`). Covered by API and browser tests. |
| 2 | No text box on the take review | **Fixed** | Screenshot 08: above Go again and Keep it. |
| 3 | "Start shooting" twice | **Fixed** | The template button now says "Let's shoot". |
| 4 | "Can't join you on this site" | **Fixed** | Screenshot 10: "Director isn't available right now." |
| 5 | The stop shutter looked round | **Fixed** | The cause was a 9999px radius that stayed round until the last frame of the morph. Screenshot 06 shows a clear square. |
| 6 | Faint progress dashes | **Fixed** | The dashes sit on a glass pill (screenshots 02 to 04). |
| 7 | The pill word | Deferred, as agreed | Slice 2. |
| 8 | Keep waits for the upload | Deferred, as agreed | Slice 3. |
| 9 | The scene-check procedure | Deferred, as agreed | Slice 16. |

## New from the fixes

### New minor A: dimming the older line can drop its contrast

`Line` dims an older caption with `opacity-60` on the whole bubble, glass included. Over
a bright camera picture, white text at 60% on a 60%-opacity dark glass can fall below
the 4.5:1 that WCAG and the quality bar ask for. Fix: keep the glass at full strength
and dim only the text, to no less than 4.5:1 against the glass over a white frame (about
80% white on the current glass), or step the older bubble down in size instead of
opacity. Check it on a screenshot over a bright frame.

### New minor B: a quick retake can leave back unguarded

When a take is thrown away, the guard pops its extra history entry with
`history.back()` and ignores the next `popstate`. `history.back()` is asynchronous. If
the member taps the shutter again before that `popstate` arrives, the new entry is
pushed and then popped by the old back. The ignore flag swallows that pop, so `pushed`
stays true with no entry under it, and the next real back during that take leaves
without asking. It's a narrow window (tens of milliseconds) and ✕ still asks, so it's a
minor. Fix: don't push while a pop of our own is pending (push in the `popstate` that
clears `ignoreNext`), and add a test that taps Go again then the shutter at once.

### For UAT to watch: the back gesture on real phones

The engineer flags this too. The guard depends on Next's app router merging its own
state into `history.pushState`, which the test router doesn't exercise. This is step 9
of the UAT script, plus one addition: "during a take, swipe back (iPhone) or use the
back gesture (Android)".

### Nits (no ticket)

- The Leave dialog shows Leave filled and above Stay. Fine for a destructive choice, but
  focus should land on Stay when it opens, so Enter doesn't leave by accident on a
  laptop.
- A cancelled countdown tells Director with no reply asked for, so it stays quiet. That's
  right for now; slice 2 can let it ask "all good?".

## UAT script changes

The slice 1 script in the spec, section 15, stands. Add to step 9: "Then start another
take and swipe back (iPhone) or use the back gesture (Android); tap Stay; then try again
and tap Leave." Pass if: both ✕ and back ask during a take; Stay keeps the take; Leave
goes to the template page.
