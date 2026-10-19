# Director v2, slice 16: polish

Spec: docs/superpowers/specs/2026-10-18-director-ux-redesign.md on origin/master. Read sections 1, 4, 12 (slice
16), 14 (quality bar) and 15. Rules: v2-common.md in this directory (time box applies: push working code within
~75 minutes, lint + check-types + unit tests of what you touch).

In priority order, stop where the time box ends:
1. Remove the scene-check procedure (`director.checkScene`), its AI agent, limits, contract, client hook, i18n
   keys and docs, which nothing calls since slice 1 (search everything; regenerate with `bun run gen`).
2. Conversation analytics in BigQuery: the Live/slower-line turn events (who, template, shot, tool calls,
   latency) through the existing BigQuery events seam (director.events), no transcripts of anything the member
   didn't consent to beyond what the consent card covers.
3. The newest Live model with proactive audio and affective dialog, if the configured model supports them on
   Vertex (check the installed SDK and the live setup in apps/api/src/modules/live); behind config, default on
   only if a quick live check passes.
4. Blooper reel: from the takes not picked, an optional short reel on the media page.
Don't touch the shoot screen layout or the editor page beyond what these need (other slices are editing them).
Base: origin/master. Branch: feat/mm/v2-polish. Stack: 8.
