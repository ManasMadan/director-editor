"""The tests' own environment: .env.example with placeholders filled, never .env."""

from pathlib import Path

from tests import ENV_EXAMPLE, PLACEHOLDER, apply_test_environment, load_test_environment


def test_is_the_example_with_placeholders_filled_without_node_env_or_empty_values(
    tmp_path: Path,
) -> None:
    example = tmp_path / ".env.example"
    example.write_text("NODE_ENV=development\nAI_SERVICE_SECRET=change-me\nS3_BUCKET=\nPORT=8000\n")
    env = load_test_environment(example)
    assert "NODE_ENV" not in env
    assert env["PORT"] == "8000"
    assert "S3_BUCKET" not in env
    assert not PLACEHOLDER.match(env["AI_SERVICE_SECRET"])
    assert len(env["AI_SERVICE_SECRET"]) >= 32


def test_uses_the_ports_of_the_checkouts_own_stack(tmp_path: Path) -> None:
    example = tmp_path / ".env.example"
    example.write_text("REDIS_URL=redis://localhost:56379\nAI_SERVICE_SECRET=change-me\n")
    (tmp_path / ".env.stack").write_text("REDIS_URL=redis://localhost:56579\n")
    assert load_test_environment(example)["REDIS_URL"] == "redis://localhost:56579"


def test_never_replaces_what_is_set(tmp_path: Path) -> None:
    example = tmp_path / ".env.example"
    example.write_text("REDIS_URL=redis://localhost:56379\nAI_SERVICE_SECRET=change-me\n")
    env = {"REDIS_URL": "redis://localhost:6379"}
    assert apply_test_environment(env, example) == ["AI_SERVICE_SECRET"]
    assert env["REDIS_URL"] == "redis://localhost:6379"


def test_covers_every_placeholder_in_the_repository() -> None:
    assert ENV_EXAMPLE.exists()
    assert [key for key, value in load_test_environment().items() if PLACEHOLDER.match(value)] == []
