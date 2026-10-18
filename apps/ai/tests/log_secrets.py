"""Logs one line full of secrets, configured as production logs, for test_activity.py to
read from this process's output: run as `python -m tests.log_secrets` in a process of its
own, since a logger already used keeps the configuration it had then (structlog caches
it), whatever a test configures later."""

from app.log import configure_logging, log

SIGNED = (
    "https://storage.example.com/t.webm?X-Amz-Date=20261018&X-Amz-Credential=AKIA1"
    "&X-Amz-Signature=deadbeef"
)

if __name__ == "__main__":
    configure_logging("info", json=True)
    log.info(
        f"fetching {SIGNED}",
        actor={"email": "ada@example.com"},
        account={
            "token": "secret-token",
            "refresh_token": "1//refresh",
            "apiKey": "k-1",
            "serviceSecret": "s-1",
        },
        body={"otp": "123456", "items": [{"Password": "hunter22"}, SIGNED], "kept": 1},
        sourceUrl=SIGNED,
        gcs="https://storage.googleapis.com/b/o?X-Goog-Signature=cafe",
    )
    try:
        raise ValueError(f"couldn't fetch {SIGNED}")
    except ValueError:
        log.exception("take download failed")
