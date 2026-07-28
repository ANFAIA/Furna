"""Tests for provider/model resolution. No network, no model instantiation."""

from __future__ import annotations

import pytest

from app import config

ROLE_VARS = ["LLM_PROVIDER", "LOCAL_MODEL", "LOCAL_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "EXPANDER_SUBAGENTS", *config.ROLE_ENV.values()]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ROLE_VARS:
        monkeypatch.delenv(name, raising=False)


def test_defaults_to_the_local_nemotron():
    spec = config.resolve("extractor")
    assert spec.provider == "local"
    assert spec.model == "nvidia/nemotron-3-nano-4b"
    assert spec.base_url == "http://localhost:1234/v1"


def test_llm_provider_switches_every_role(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    specs = config.all_specs()
    assert {spec.provider for spec in specs.values()} == {"anthropic"}
    assert specs["expander"].model == "claude-sonnet-5"
    assert specs["expander"].base_url is None


def test_role_override_can_mix_providers(monkeypatch):
    monkeypatch.setenv("EXTRACTOR_MODEL", "local:qwen3-4b")
    monkeypatch.setenv("EXPANDER_MODEL", "anthropic:claude-opus-5")
    assert config.resolve("extractor").label == "local:qwen3-4b"
    assert config.resolve("expander").label == "anthropic:claude-opus-5"
    assert config.resolve("subagent").provider == "local"  # untouched, follows the default


def test_bare_model_name_uses_the_default_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("EXPANDER_MODEL", "claude-haiku-4-5-20251001")
    spec = config.resolve("expander")
    assert spec.provider == "anthropic"
    assert spec.model == "claude-haiku-4-5-20251001"


def test_model_name_containing_a_colon_is_not_read_as_a_provider(monkeypatch):
    monkeypatch.setenv("EXPANDER_MODEL", "qwen3:4b")  # the Ollama naming style
    spec = config.resolve("expander")
    assert spec.provider == "local"
    assert spec.model == "qwen3:4b"


def test_local_base_url_is_configurable(monkeypatch):
    monkeypatch.setenv("LOCAL_BASE_URL", "http://localhost:11434/v1/")
    assert config.resolve("extractor").base_url == "http://localhost:11434/v1"


def test_missing_anthropic_key_is_only_a_problem_when_anthropic_is_used(monkeypatch):
    assert config.missing_requirements() == []  # all local

    monkeypatch.setenv("EXPANDER_MODEL", "anthropic:claude-sonnet-5")
    assert any("ANTHROPIC_API_KEY" in problem for problem in config.missing_requirements())

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert config.missing_requirements() == []


def test_unknown_provider_is_reported(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "together")
    assert any("Unknown provider" in problem for problem in config.missing_requirements())


def test_structured_output_strategy_follows_the_provider(monkeypatch):
    from langchain.agents.structured_output import ProviderStrategy, ToolStrategy

    from app.schemas import EntityExtraction

    assert isinstance(config.response_strategy("extractor", EntityExtraction), ProviderStrategy)

    monkeypatch.setenv("EXTRACTOR_MODEL", "anthropic:claude-sonnet-5")
    assert isinstance(config.response_strategy("extractor", EntityExtraction), ToolStrategy)


def test_local_completion_ceiling_is_capped(monkeypatch):
    monkeypatch.setenv("LOCAL_MAX_TOKENS", "1200")
    model = config.chat_model("extractor", max_tokens=16000)
    assert model.max_tokens == 1200

    # Anthropic is left alone: its windows are large enough for the ask.
    monkeypatch.setenv("EXPANDER_MODEL", "anthropic:claude-sonnet-5")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert config.chat_model("expander", max_tokens=8000).max_tokens == 8000


def test_subagents_default_off_locally_and_on_for_anthropic(monkeypatch):
    assert config.uses_subagents() is False

    monkeypatch.setenv("EXPANDER_MODEL", "anthropic:claude-sonnet-5")
    assert config.uses_subagents() is True


def test_subagents_can_be_forced_either_way(monkeypatch):
    monkeypatch.setenv("EXPANDER_SUBAGENTS", "1")
    assert config.uses_subagents() is True

    monkeypatch.setenv("EXPANDER_SUBAGENTS", "0")
    monkeypatch.setenv("EXPANDER_MODEL", "anthropic:claude-sonnet-5")
    assert config.uses_subagents() is False


def test_solo_prompt_drops_the_delegation_steps():
    from app.agents import EXPANDER_PROMPT, SOLO_EXPANDER_PROMPT

    assert "subagent" in EXPANDER_PROMPT
    assert "Call the `definer` subagent" not in SOLO_EXPANDER_PROMPT
    assert "Cover three angles yourself" in SOLO_EXPANDER_PROMPT
    # The parts that are not about delegation must survive the substitution.
    assert "budget in `<length>` exactly" in SOLO_EXPANDER_PROMPT
    assert "highlights a free-form fragment" in SOLO_EXPANDER_PROMPT


def test_openrouter_is_a_first_class_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    spec = config.resolve("expander")
    assert spec.provider == "openrouter"
    assert spec.model == "inclusionai/ling-3.0-flash:free"
    assert spec.base_url == "https://openrouter.ai/api/v1"


def test_a_free_model_suffix_is_not_read_as_a_provider(monkeypatch):
    """`:free` is part of the model id, and it sits where a provider prefix would."""
    monkeypatch.setenv("EXPANDER_MODEL", "openrouter:inclusionai/ling-3.0-flash:free")
    spec = config.resolve("expander")
    assert spec.provider == "openrouter"
    assert spec.model == "inclusionai/ling-3.0-flash:free"

    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("EXPANDER_MODEL", "inclusionai/ling-3.0-flash:free")
    assert config.resolve("expander").model == "inclusionai/ling-3.0-flash:free"


def test_openrouter_needs_its_own_key(monkeypatch):
    monkeypatch.setenv("EXTRACTOR_MODEL", "openrouter:inclusionai/ling-3.0-flash:free")
    assert any("OPENROUTER_API_KEY" in p for p in config.missing_requirements())

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    assert config.missing_requirements() == []


def test_openrouter_sends_the_attribution_headers(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    model = config.chat_model("expander", max_tokens=2000)
    assert model.default_headers["X-Title"] == "Furna"
    assert model.openai_api_base == "https://openrouter.ai/api/v1"


def test_a_discovered_window_sizes_the_request(monkeypatch):
    """Half of what is left after the prompt — the agent's second turn needs room."""
    spec = config.ModelSpec(role="expander", provider="local", model="m", base_url="http://x/v1")
    monkeypatch.setattr(config, "context_window", lambda _spec: 8192)
    assert config.completion_ceiling(spec, 8000) == (8192 - config.PROMPT_RESERVE) // 2

    monkeypatch.setattr(config, "context_window", lambda _spec: 262144)
    assert config.completion_ceiling(spec, 8000) == 8000  # the ask, not the window


def test_an_undiscoverable_window_falls_back_to_the_env_ceiling(monkeypatch):
    spec = config.ModelSpec(role="expander", provider="local", model="m", base_url="http://x/v1")
    monkeypatch.setattr(config, "context_window", lambda _spec: None)
    monkeypatch.setenv("LOCAL_MAX_TOKENS", "1500")
    assert config.completion_ceiling(spec, 8000) == 1500


def test_anthropic_is_never_clamped(monkeypatch):
    spec = config.ModelSpec(role="expander", provider="anthropic", model="claude-sonnet-5")
    monkeypatch.setenv("LOCAL_MAX_TOKENS", "100")
    assert config.completion_ceiling(spec, 8000) == 8000


def test_routing_is_pinned_when_the_model_supports_the_request(monkeypatch):
    """A model is served by several providers; not all accept `response_format`.

    Without pinning, the app fails at the worst moment — mid-panel, with the
    provider's own 400 — depending on where the request happened to land.
    """
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setattr(
        config, "_openrouter_catalogue",
        lambda _url: {"inclusionai/ling-3.0-flash:free": {"supported_parameters": ["structured_outputs"]}},
    )
    model = config.chat_model("expander", max_tokens=2000)
    assert model.extra_body == {"provider": {"require_parameters": True}}


def test_routing_is_not_pinned_when_no_provider_could_satisfy_it(monkeypatch):
    """Pinning a requirement nothing offers turns every call into a 404."""
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setattr(
        config, "_openrouter_catalogue",
        lambda _url: {"inclusionai/ling-3.0-flash:free": {"supported_parameters": ["temperature"]}},
    )
    model = config.chat_model("expander", max_tokens=2001)
    assert model.extra_body is None


def test_structured_output_capability_is_read_from_the_catalogue(monkeypatch):
    monkeypatch.setattr(
        config, "_openrouter_catalogue",
        lambda _url: {
            "yes:free": {"supported_parameters": ["structured_outputs"]},
            "no:free": {"supported_parameters": ["temperature"]},
        },
    )
    spec = lambda m: config.ModelSpec(role="expander", provider="openrouter", model=m, base_url="u")
    assert config.supports_structured_output(spec("yes:free")) is True
    assert config.supports_structured_output(spec("no:free")) is False
    # Unknown to the catalogue: try it and let the call report the truth.
    assert config.supports_structured_output(spec("mystery:free")) is True
    # Local and Anthropic are never in question.
    assert config.supports_structured_output(
        config.ModelSpec(role="expander", provider="local", model="m", base_url="u")
    ) is True


def test_a_local_server_gets_no_routing_directives(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "local")
    assert config.chat_model("expander", max_tokens=2000).extra_body is None


def test_the_extractor_can_ask_for_no_reasoning(monkeypatch):
    """A scratchpad nobody reads is paid for twice: in tokens and in budget."""
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    model = config.chat_model("extractor", max_tokens=2000, thinking=False)
    assert model.extra_body["reasoning"] == {"enabled": False, "exclude": True}


def test_reasoning_is_left_alone_by_default(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    model = config.chat_model("expander", max_tokens=2000)
    assert "reasoning" not in (model.extra_body or {})


def test_a_local_server_gets_no_openrouter_directives(monkeypatch):
    """`reasoning` and `provider` are OpenRouter routing vocabulary."""
    monkeypatch.setenv("LLM_PROVIDER", "local")
    model = config.chat_model("extractor", max_tokens=2000, thinking=False)
    assert model.extra_body is None
