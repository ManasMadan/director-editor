### Workstream 2.5: Gemini video call (Live API relay)

**Interfaces — Produces:** WebSocket `wss://director.mmadan.in/api/live?videoId=…&shot=n` (session cookie auth, `inOrg`). Client → server messages: `{type:"audio", pcm16: base64}` (16 kHz mono), `{type:"frame", jpeg: base64}` (≤ 1 fps), `{type:"text", text}`. Server → client: `{type:"audio", pcm16}` (24 kHz), `{type:"transcript", who:"you"|"director", text}`, `{type:"tool", name:"start_recording"|"stop_recording"|"next_shot"|"retake"|"previous_shot", args}`, `{type:"error", code}`. Web hook `useLiveCall({videoId, shotIndex, onTool}) → {state:"idle"|"connecting"|"live"|"ended"|"failed", start(), end(), muted, toggleMute()}`.

#### Task 2.5.1: Relay in the api
