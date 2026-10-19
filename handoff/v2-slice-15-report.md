# Slice 15: create a template from scratch — report

Branch `feat/mm/v2-create` (from `origin/feat/mm/v2-assets`), stack 9. Pushed at `ee95ee5`.

## What I built

- **Library door**: a "Describe your own" card links to `/create`. A created template's card
  shows a gradient with a pen instead of a YouTube thumbnail, labelled "Yours".
- **Create page `/create`**: an idea box, up to 4 photos (new upload purpose
  `director-brief-photo`: signed upload, ClamAV and type check, re-encoded to JPEG, then waited on
  until ready), "Talk it through" (Director asks at most 3 questions), an answer box, and "Write
  my shots". **Voice is browser dictation** (a Web Speech API mic button on the idea and answer
  boxes). The spec asks for a Gemini Live brainstorm. That needs a new Live setup mode on the
  relay, which wasn't possible in the time box, so it's a follow-up.
- **AI service** (`apps/ai/app/create.py`, `Creator`):
  - `POST /v1/director/brainstorm`: Gemini (DIRECTOR_MODEL) reads the brief, the talk so far and
    the photos as images, and returns a reply and whether it's ready. The service counts
    Director's turns: after 3 questions it tells Gemini to wrap up and forces `ready`.
  - `POST /v1/director/created`: makes a plan row with `source='created'`, the brief stored on it
    and a random 11-character id in a YouTube id's shape, so every route, take, cut, shoot and edit
    page works unchanged. It then queues a new `create-plan` job carrying the photos' presigned
    URLs, the same pattern as `review-take`.
  - The job writes the plan with `CREATE_INSTRUCTIONS` and `ShotPlanDraft` output, then runs the
    indexer's `repair_plan`. Shots go back to back. The summary must carry every wish the member
    gave ("no talking"), and the scenes must name what's in the photos. It fails with
    DIRECTOR_CREATE_FAILED.
  - `PUT /v1/director/created`: the owner's edits to the shots. The service lays them back to back
    again and clamps edits and assets to the new length. Anyone else gets
    DIRECTOR_PLAN_NOT_EDITABLE.
  - **Nano Banana storyboards**: `AssetMaker.claim_storyboards` claims one card per distinct shot
    as an `ai.director_asset` row with `origin='storyboard'`. The card's id is a digest of its
    prompt (`app/storyboards.py`), so cards follow their shots through reorders. The existing
    `assets` job draws them. They count toward the 30-images-a-day limit. The plan read returns
    `storyboards`, and the API signs them into `shots[i].storyboardUrl`.
- **API**: new procedures `director.brainstorm` (40 an hour), `director.create` (10 an hour) and
  `director.editPlan` (POST `/director/{videoId}/plan`). The plan has `source: "created"` and an
  optional `brief`. New codes: DIRECTOR_CREATE_LIMIT, DIRECTOR_PLAN_NOT_EDITABLE and
  DIRECTOR_CREATE_FAILED. FILE_NOT_FOUND is now passed on from the AI service. New activity names
  added.
- **Edit page `/create/<videoId>`**: Gemini's loader while the plan is written, then shot cards
  (storyboard, what, where, seconds) with move, delete, add, save, and "Looks good, let's shoot".
- **Template page**: a created plan shows its storyboard cards and "Change the shots" instead of
  the YouTube player, with no original-sound choice.
- **Counting**: at most 5 created templates a day per member (`ai.created_today`), separate from
  the one indexed Short. Usage is recorded as `director-create`.
- **Migration** `20261018230000_director_created`, expand only: a nullable `brief` column, the
  source and origin checks widened (re-added NOT VALID), and the function.

## Acceptance (spec 10)

- Coffee idea with photos gives a plan of 4 to 6 shots naming what's in the photos: built end to
  end and tested through the fakes (the photo reaches Gemini as an image, a 4-shot plan is
  saved). **Not checked live on Vertex.**
- Edit one shot's place and delete another: tested in `test_the_member_edits...` and available
  in the UI.
- Director knows "no talking": the summary carries it, and Live's system instruction includes
  the summary. **Not checked live.**
- At most 3 questions: enforced by the service and tested.
- Created templates counted separately: tested. Storyboards drawn and following their shots:
  tested.

## Not done

Gemini Live brainstorm (dictation instead), Lyria and Veo for created templates, `director.revise`
"ask to change it" (not on this base), photos as image references for storyboards, client-hook
tests, an apps/api integration test, and web browser and e2e tests (web coverage of the new
pages will be below 100%).

## Commits

3173299, d0a181e, 2679a53, ee95ee5.

## Deploy

Run the migration. Redeploy ai (API and worker), api, worker and web. No new env vars.
Merge note: slice 10 also edits `assets.py` (`Artist.draw_prompt`, `_Job`), so that needs a hand
merge.
