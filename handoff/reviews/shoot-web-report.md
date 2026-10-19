# fix/mm/shoot-web report

Branch `fix/mm/shoot-web`, rebased onto origin/master 8066e7bd (v1.7.1). Pushed head: **ab57988a**.

## Landed (each with a test that failed first)

| Item | What changed | Test |
|---|---|---|
| F4 | `enqueue` resolves once the item is in the store; `send()` is the drain. A flip no longer waits for the backlog. | client `recording.test.tsx` |
| F5 | A slice is never refused. `full` is derived (queue ≥ 5 min) and the screen pauses; slices that cross the limit are kept. A store write failure is reported as `lost`. | client `recording.test.tsx` |
| F6 | `UploadNotice` on the shoot screen (lost footage with the API's message, footage waiting or a full queue, near the 20-minute limit). `SavingFootage` links to the editor, and the editor keeps uploading (`useSliceUploader`). | `roll-parts.test.tsx` |
| F7 | The live AudioContext wakes on its own `statechange` while visible, on Resume, on return to the page, and on any tap or key (`useWakeAudio`). | `lib/live-audio.test.tsx`, `shoot-hooks.test.tsx` |
| F8 | The camera closes before the other one opens. | `use-camera.test.tsx` |
| F11 | Editor choices are kept in sessionStorage per member and template, parsed by `editorChoicesSchema`. A server-side save would be better, so they follow the member across devices. | `use-edit-history.test.tsx` |
| F12 | Realtime invalidation skips `alignMatchCut`. | client `realtime-hooks.test.tsx` |
| F14 / F15 | `requestData` on pause and pagehide; a flip while the roll is starting is queued. | `roll.test.ts` |
| F17 | Already fixed on master (#40, `lib/wake-lock.ts`). My regression test is kept. | `shoot-hooks.test.tsx` |
| F19 | TellBox focus ring. Space ignores buttons, inputs and dialogs. Gap tiles are named by their visible text. Send moved out of the label. Picker clips play only on hover or focus. | `editor-a11y.test.tsx`, `roll-parts.test.tsx`, `shoot.test.tsx` |
| F20 | `hooks/use-editor-talk.ts` applies an answer to the choices as they are when it lands. | `use-editor-talk.test.tsx` |
| F21 | Create brief draft in sessionStorage per member. A failed brainstorm turn is rolled back. | `create.test.tsx` |
| UAT1-11 | The roll's shot strip has its own scrolling row with 44 px dots; ✕ is pinned. | `roll.test.tsx` |
| UAT1-27 | ✕ and back ask first while the roll records or is paused, with roll copy. | `roll.test.tsx` |
| UAT1-12 | The API's `recording.start` answers the member's open session of the short. The roll carries it on (part and attempt numbers, elapsed time) and ends each part a dead tab left open, counting slices stored on the server and those still on the device. `pagehide` finishes the session. | api `recording.integration.test.ts`, `roll.test.ts`, `roll.test.tsx` |

## Remaining (not started)

- UAT1-17 / UAT1-18: empty takes and the MP4 codec-description warning. Pin the recording resolution, or start a new part when the video track's settings change. Server side, #41 already refuses cuts under 0.5 s.
- UAT1-05 / UI1-20: on the shared demo account, say up front that takes use the shutter.
- UI1-23: ✕ during a take shouldn't stop it until the member picks Leave.
- UI1-45: no ✕, back or title before Start shooting.
- UI1-51: the start card is cut off in phone landscape.
- UI1-24: the shot card's line is clipped at two lines with no way to read the rest.

## Verified at ab57988a

- `bun run lint` and `bun run check-types`: pass.
- Unit tests: web 237 and client 110 pass. Recording API integration: 23 pass.
- Browser (files): roll and edit, 14 pass.
- Earlier on this branch, every touched browser file passed on its own. Two shoot tests, "says less the second time" and "puts the member's twist on the card", fail on master as well.
- The machine was very loaded (load average about 46, other sessions' vitest runs), so full-directory browser runs time out at random. Single files are reliable.
- `type-coverage` shows one pre-existing miss in `slice-store.ts:168`, not from this branch.
