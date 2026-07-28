"""Pin the environment the whole suite runs under.

`app.server` calls `load_dotenv()` at import, so without this a developer's own
`.env` decides which provider the tests exercise — and a file that is not even
in the repository can turn the suite red. Tests state their own configuration.
"""

from __future__ import annotations

import pytest

from app import config

MANAGED_VARS = (
    "LLM_PROVIDER",
    "LOCAL_MODEL",
    "LOCAL_BASE_URL",
    "LOCAL_MAX_TOKENS",
    "LOCAL_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_SITE",
    "OPENROUTER_TITLE",
    "EXPANDER_SUBAGENTS",
    "EXTRACTION_CONCURRENCY",
    *config.ROLE_ENV.values(),
)


@pytest.fixture(autouse=True)
def pinned_environment(monkeypatch):
    """Local provider, no keys, and no network probe for a context window."""
    for name in MANAGED_VARS:
        monkeypatch.delenv(name, raising=False)
    # These would otherwise reach the network: the window probe hits whatever
    # server happens to be up, and the capability check hits OpenRouter's live
    # catalogue. Both make results depend on the machine and the day.
    monkeypatch.setattr(config, "context_window", lambda _spec: None)
    monkeypatch.setattr(config, "_openrouter_catalogue", lambda _base_url: {})
    yield
