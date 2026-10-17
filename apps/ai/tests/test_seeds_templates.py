"""The committed apps/ai/app/seeds/templates.json (task-2.2.5-brief.md): every one of
the 6 seeds from seeds.json, indexed for real with Gemini and committed so every new
workspace starts with the same library (task 2.2.2 copies these rows at sign-up). This
only checks the file that's checked in, not scripts/build_seeds.py's logic (see
test_build_seeds.py for that): it's what keeps the committed file honest when the plan
schema changes under it.
"""

from pydantic import TypeAdapter

from scripts.build_seeds import SEEDS_PATH, TEMPLATES_PATH, SeedTemplate, load_seeds

_TEMPLATES = TypeAdapter(list[SeedTemplate])


def test_every_seed_has_a_template_with_a_real_shot_plan() -> None:
    seeds = load_seeds(SEEDS_PATH)
    templates = _TEMPLATES.validate_json(TEMPLATES_PATH.read_text())

    assert {template.videoId for template in templates} == {seed.videoId for seed in seeds}
    assert len(templates) == len(seeds) == 6
    for template in templates:
        assert len(template.plan.shots) >= 1
