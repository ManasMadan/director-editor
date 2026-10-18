# How to run UAT for Director

A one-page guide for testing each slice on a real phone. The scripts themselves, one per
slice, are in [the product spec, section 15](2026-10-18-director-ux-redesign.md#15-uat-plan),
and what "good" means is its quality bar, section 14.

## Before you start

- **Phones.** One recent iPhone on Safari and one mid-range Android on Chrome. Run each
  script on both unless it says otherwise.
- **Where.** A quiet room with a window, unless the script asks for something else. For
  the noise checks, a room with music or a TV on.
- **Account.** Your own Google account for anything that posts; the demo for the
  three-minute path.
- **Build.** The slice is on production (or the preview link engineering sends) and I've
  already reviewed it against the spec.

## Record it

Either works; pick one and keep to it:

- **Screen recording with sound.** iPhone: Control Centre, long-press Screen Recording,
  turn the microphone on. Android: Quick Settings, Screen record, "Device audio and
  microphone". This catches Director's voice, captions and timings.
- **Film yourself with a second phone**, pointed at the test phone's screen and you. Best
  for checks about the camera, framing, the ghost and marks on real things.

Say the slice number and the phone out loud at the start ("slice 3, iPhone"). Keep the
recording running through the whole script, mistakes included.

## Run the script

1. Do the setup.
2. Follow the steps in order. Lines in quotes are said exactly as written, then naturally
   if Director asks something back.
3. Don't help the product: if something doesn't happen, wait ten seconds, then carry on
   and say what you expected ("I expected the chip to appear").
4. If you notice anything outside the script (a glitch, an odd line, something that felt
   slow or awkward), say it out loud there and then.

## Send it

For each run, send:

- the video;
- the slice and the phone;
- a few lines of notes: anything that felt wrong, slow, confusing or great, with the
  rough time in the video;
- your gut call: pass or fail.

## What happens next

I watch the video against the script's pass criteria and the quality bar, and reply with
pass or fail per check. Every failure becomes a fix ticket for engineering, with the
moment in your video, what should have happened, the spec section and a severity
(blocker, major, minor). When the fixes land, you rerun only the failed steps. A slice is
done when every check passes on both phones.
