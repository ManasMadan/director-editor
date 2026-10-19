## 14. Quality bar

Every review and UAT checks against these. Each is a concrete check; "phone" means a
recent iPhone on Safari and a mid-range Android on Chrome.

### Apple Human Interface Guidelines (as they apply to a web app)

| Check | How to test |
|---|---|
| Camera fills the screen; controls sit in the bottom third, in thumb reach | Hold the phone one-handed; reach flip, Done and the text box without shifting grip |
| Recording state is always visible | The red dot and time are on screen whenever recording, including with the keyboard open and controls faded |
| Camera and microphone permission is explained before the browser asks | First visit: an explanation card appears before the system prompt, never the prompt cold |
| Sheets (asset picker, publish, lists) open at half height with a grabber, expand, and swipe down to dismiss; with unsaved changes, dismissing asks first | Open each sheet; drag; dismiss with changes |
| Touch targets at least 44 × 44 pt | Measure in the browser's inspector at phone width |
| Haptics mark meaning, not noise: a light buzz on a new best, a success pattern at the wrap, none during attempts (Android only: iOS Safari has no vibration API, so it gets the visual instead) | Feel for them on Android; confirm none during an attempt |
| Text scales: at 200% browser text size, nothing is clipped, overlaps or needs horizontal scrolling | Set text size to 200% (iOS Safari's page zoom, Chrome's font size) and walk every screen |
| Safe areas: nothing under the notch, Dynamic Island, rounded corners or home indicator, in portrait and landscape | iPhone with a Dynamic Island, both orientations |

### Material 3 and Android app quality (as they apply to a web app)

| Check | How to test |
|---|---|
| Touch targets at least 48 × 48 dp with 8 dp between | Inspector at phone width |
| The back gesture closes the top sheet or dialog first; on the shoot screen it asks before ending a recording | Use back on every screen |
| Works from 320 px wide to tablets and foldables: no horizontal scroll; the editor uses two panes from 840 px | Resize from 320 to 1280 px; open on a tablet |
| Portrait-first shoot screen; landscape keeps controls usable and the indicator visible | Rotate during a session |
| Light and dark themes both meet contrast; the shoot screen is dark in both | Switch the system theme |
| State survives backgrounding: switching apps pauses, returning resumes only on a tap | Switch apps mid-session |

### Accessibility: WCAG 2.2 AA

| Check | How to test |
|---|---|
| Text contrast 4.5:1, large text and UI parts 3:1, including captions over video | Contrast checker on screenshots, captions over a bright frame |
| Everything works by keyboard on a laptop, with a visible focus that isn't hidden under sheets or toasts | Tab through every screen |
| Director's speech is always on screen as text | Mute the phone; follow the session from captions alone |
| Status changes are announced ("Attempt 3 clipped", "Paused", "Swapped in take 3") | VoiceOver and TalkBack |
| Every drag (trim handles, sheets) has a tap alternative (nudge buttons) | Trim without dragging |
| No time limits the member can't control; nudges are not deadlines | Leave the shoot idle five minutes: nothing ends or deletes |
| Reduced motion replaces confetti, slides and pulses with fades | Turn on Reduce Motion |
| Every control has a name that matches its label | Screen-reader pass on shoot, editor, picker |

### Core Web Vitals and load

| Check | Target (75th percentile, mid-range Android on 4G) |
|---|---|
| Largest Contentful Paint on landing, library, template | 2.5 s or less |
| Interaction to Next Paint, every screen | 200 ms or less |
| Cumulative Layout Shift | 0.1 or less |
| Camera preview after permission is granted | 1.5 s or less |
| Editor interactive with ten takes | 3 s or less |
| First-load JavaScript | within the repo's bundle budget (`bun run --cwd apps/web budget`) |

### The conversation: latency and motion

| Check | Target |
|---|---|
| "Start shooting" to Director's first word | 2.5 s median, 4 s at worst in ten tries |
| Member stops talking to Director's voice starting | 0.8 s median, 1.5 s at worst |
| Member talks over Director: Director's audio stops | within 0.3 s |
| A tool's effect on screen after Director says it (card change, chip, mark) | within 1 s of the sentence starting |
| Attempt ends to its take appearing in the progress list | within 60 s |
| Editor request ("use the parrot one") to the swap | within 3 s |
| Post-session pass for 10 minutes of footage | within 5 minutes |
| Motion: transitions 200 to 300 ms, ease-out; highlights at most 600 ms; nothing animates in a way that blocks a tap | Watch the screen recording frame by frame |

### Privacy and consent for always-on recording

| Check | How to test |
|---|---|
| Recording never starts without the "Start shooting" tap, and the first time, a plain explanation that the chat is recorded too | Fresh account; read the card; confirm nothing records before the tap |
| Only a touch resumes after a pause; voice and Director can't | Say "resume", "start recording"; wait; nothing records |
| Pause also stops what Director sees and hears | Pause, wave and talk; ask afterwards "what did I just do?": Director can't know |
| Switching apps, locking or closing pauses | Lock the phone mid-session; the recording shows a gap |
| Raw footage is deleted on schedule; "delete this session" deletes raw footage and clips now | Delete a session; its storage objects are gone (checked by engineering) |
| Demo guests never see each other's footage | Two phones on the demo |
| Uploads say once that they must be the member's to use | Upload an image |
| The privacy page says what's recorded, where it's kept, for how long, and that Google doesn't train on it under Vertex AI's terms | Read `/privacy` |

### Errors and empty states

| Check | How to test |
|---|---|
| Every empty screen (library, My media, a shot's takes, the picker's results) says what goes there and offers the next action | New account; walk each |
| Every error says what happened and what to do, in plain words, never a code or a stack | Force each: airplane mode, denied camera, quota, failed upload, failed generation |
| Loading uses the Gemini loader with words, never a bare spinner; anything over 10 s says it's still working | Throttle the network |
| Nothing is lost on failure: footage queues, edits persist, a failed save can be retried | Kill the tab during upload and during save |

### Tone of voice

| Check | How to test |
|---|---|
| Director answers every turn, in one or two sentences, with one ask at most | Count in a session transcript |
| Director never repeats an instruction the member declined, never corrects a same-meaning rewording | The pushback and rewording lines in the UAT scripts |
| Director never says "plan", "template", "tool", "session", "model", "error", or field names | Transcript search |
| Honest once, then the member's call: a "not quite" note comes at most once per attempt and "keep it" is always accepted | The bad-attempt UAT step |
| UI copy is sentence case, second person, short, at most one exclamation mark per screen, no "AI credit", no "call" | Copy review of every screen |

---

## 15. UAT plan
