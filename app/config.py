"""Model wiring: Anthropic, a local OpenAI-compatible server, or both at once.

Every role (`extractor`, `expander`, `subagent`) resolves independently, so the
useful hybrid — cheap local extraction, strong remote synthesis — is one line of
env config:

    EXTRACTOR_MODEL=local:nvidia/nemotron-3-nano-4b
    EXPANDER_MODEL=anthropic:claude-sonnet-5

A bare model name uses ``LLM_PROVIDER`` (default ``local``). Three providers are
supported: ``local`` (any OpenAI-compatible server), ``anthropic``, and
``openrouter`` — whose ``:free`` models make a useful middle ground between a
cramped local window and a paid API.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from langchain_core.language_models.chat_models import BaseChatModel

DEFAULT_PROVIDER = "local"
DEFAULT_LOCAL_MODEL = "nvidia/nemotron-3-nano-4b"
DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1"  # LM Studio; Ollama uses :11434/v1
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"
DEFAULT_OPENROUTER_MODEL = "inclusionai/ling-3.0-flash:free"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

PROVIDERS = ("local", "anthropic", "openrouter")

ROLE_ENV = {
    "extractor": "EXTRACTOR_MODEL",
    "expander": "EXPANDER_MODEL",
    "subagent": "SUBAGENT_MODEL",
}


@dataclass(frozen=True)
class ModelSpec:
    role: str
    provider: str
    model: str
    base_url: str | None = None

    @property
    def label(self) -> str:
        return f"{self.provider}:{self.model}"


def provider_default() -> str:
    return os.getenv("LLM_PROVIDER", DEFAULT_PROVIDER).strip().lower()


def local_base_url() -> str:
    return os.getenv("LOCAL_BASE_URL", DEFAULT_LOCAL_BASE_URL).rstrip("/")


def openrouter_base_url() -> str:
    return os.getenv("OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL).rstrip("/")


def resolve(role: str) -> ModelSpec:
    """Read the env for one role and say which provider and model to use."""
    raw = (os.getenv(ROLE_ENV[role]) or "").strip()
    provider = provider_default()
    model = ""

    if raw:
        if ":" in raw and raw.split(":", 1)[0].lower() in PROVIDERS:
            provider, model = raw.split(":", 1)
            provider = provider.lower()
        else:
            model = raw

    if not model:
        model = {
            "local": lambda: os.getenv("LOCAL_MODEL", DEFAULT_LOCAL_MODEL),
            "openrouter": lambda: os.getenv("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL),
        }.get(provider, lambda: os.getenv("ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL))()

    base_url = {
        "local": local_base_url,
        "openrouter": openrouter_base_url,
    }.get(provider)

    return ModelSpec(
        role=role,
        provider=provider,
        model=model,
        base_url=base_url() if base_url else None,
    )


def all_specs() -> dict[str, ModelSpec]:
    return {role: resolve(role) for role in ROLE_ENV}


def _reasoning_aware_openai_class():
    """ChatOpenAI, but keeping the reasoning tokens it otherwise throws away.

    Reasoning models behind an OpenAI-compatible server stream their scratchpad
    as `delta.reasoning_content`. langchain-openai has no mapping for that field
    and silently drops it, so the chunks arrive empty and the UI has nothing to
    show while a slow local model thinks. This restores it into
    `additional_kwargs`, where the rest of the app already looks for it.
    """
    from langchain_openai import ChatOpenAI

    class ReasoningChatOpenAI(ChatOpenAI):
        def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
            generation = super()._convert_chunk_to_generation_chunk(
                chunk, default_chunk_class, base_generation_info
            )
            choices = chunk.get("choices") or []
            if not generation or not choices:
                return generation
            delta = choices[0].get("delta") or {}
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoning:
                generation.message.additional_kwargs["reasoning_content"] = reasoning
            return generation

    return ReasoningChatOpenAI


def _extra_body(
    provider: str, model: str, base_url: str | None, structured: bool, thinking: bool
) -> dict:
    """Provider directives that ride along with the request.

    Local servers get none of this: it is OpenRouter routing vocabulary.
    """
    if provider == "local":
        return {}

    body: dict = {}
    # One OpenRouter model is served by several providers that do not all
    # implement the same features, so pin the routing to those that accept what
    # we send — but only when the model advertises the feature at all, since
    # otherwise no endpoint qualifies and every request 404s.
    if structured and supports_structured_output(
        ModelSpec(role="", provider=provider, model=model, base_url=base_url)
    ):
        body["provider"] = {"require_parameters": True}
    # A scratchpad nobody reads is paid for twice: once in tokens, once in the
    # completion budget it eats before the answer starts. Extraction shows none
    # of it, so it asks for none.
    if not thinking:
        body["reasoning"] = {"enabled": False, "exclude": True}
    return body


@lru_cache(maxsize=None)
def _build(
    provider: str,
    model: str,
    base_url: str | None,
    max_tokens: int,
    structured: bool = True,
    thinking: bool = True,
) -> BaseChatModel:
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model, max_tokens=max_tokens, temperature=0)

    if provider in ("local", "openrouter"):
        ChatOpenAI = _reasoning_aware_openai_class()
        is_local = provider == "local"
        return ChatOpenAI(
            model=model,
            base_url=base_url,
            # Local servers ignore the key but the OpenAI client insists on one.
            api_key=(
                os.getenv("LOCAL_API_KEY", "not-needed")
                if is_local
                else os.getenv("OPENROUTER_API_KEY", "")
            ),
            max_tokens=max_tokens,
            temperature=0,
            timeout=float(os.getenv("LOCAL_TIMEOUT", "600")),
            # OpenRouter attributes usage to these; they also decide whether a
            # free model is served at all when the pool is busy.
            default_headers=None if is_local else {
                "HTTP-Referer": os.getenv("OPENROUTER_SITE", "http://localhost:8787"),
                "X-Title": os.getenv("OPENROUTER_TITLE", "Furna"),
            },
            # One OpenRouter model is served by several providers that do not
            # all implement the same features, so pin the routing to those that
            # accept what we send — but only when the model advertises the
            # feature at all, since otherwise no endpoint qualifies and every
            # request 404s.
            extra_body=_extra_body(provider, model, base_url, structured, thinking) or None,
        )

    raise ValueError(
        f"Unknown provider: {provider!r}. Use one of {', '.join(PROVIDERS)}."
    )


#: What the app needs from a local context window before it stops fighting it.
RECOMMENDED_CONTEXT = 16384


@lru_cache(maxsize=4)
def _openrouter_catalogue(base_url: str) -> dict[str, dict]:
    """OpenRouter's model list, keyed by id. Empty when it cannot be read."""
    import json
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"{base_url}/models", timeout=4) as response:
            payload = json.load(response)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return {}
    return {entry["id"]: entry for entry in payload.get("data", []) if entry.get("id")}


def openrouter_context_window(base_url: str, model: str) -> int | None:
    return (_openrouter_catalogue(base_url).get(model) or {}).get("context_length") or None


def supports_structured_output(spec: ModelSpec) -> bool:
    """Can this model be asked for a JSON schema, or must we ask in words?

    Most of OpenRouter's free tier cannot: only 4 of 15 advertise
    `structured_outputs`. Asking anyway is worse than not asking — the request
    is routed to whichever provider is free, and a provider without the feature
    rejects it outright, so the same model works or fails by luck of the draw.
    """
    if spec.provider != "openrouter":
        return True
    entry = _openrouter_catalogue(spec.base_url or "").get(spec.model)
    if entry is None:
        return True  # unknown catalogue: assume it works and let the call say otherwise
    return "structured_outputs" in (entry.get("supported_parameters") or [])


@lru_cache(maxsize=8)
def local_context_window(base_url: str) -> int | None:
    """Ask LM Studio how big the loaded model's window actually is.

    The OpenAI-compatible endpoint does not expose it, but LM Studio's own
    `/api/v0/models` does, and it is the difference between sizing a request
    correctly and getting `Context size has been exceeded` half a minute in.
    Any other server simply returns nothing here and the caller falls back.
    """
    import json
    import urllib.error
    import urllib.request

    root = base_url.rsplit("/v1", 1)[0]
    try:
        with urllib.request.urlopen(f"{root}/api/v0/models", timeout=2) as response:
            payload = json.load(response)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None

    windows = [
        entry.get("loaded_context_length")
        for entry in payload.get("data", [])
        if entry.get("state") == "loaded" and entry.get("loaded_context_length")
    ]
    return min(windows) if windows else None


#: Measured, not guessed: an expansion prompt with the trimmed harness and a
#: full document comes to ~2950 tokens on this app's templates.
PROMPT_RESERVE = 3000


def local_completion_ceiling(base_url: str, requested: int) -> int:
    """How many completion tokens a local server can actually afford.

    Not simply "the window minus the prompt". The agent loop re-sends the whole
    conversation on its next turn, so a first answer that exactly fills the
    remaining space guarantees the second turn overflows — which is how this
    surfaced: a panel that streamed 197 chunks and then died with
    `Context size has been exceeded`. Halving what is left leaves room for that
    second turn.
    """
    ceiling = int(os.getenv("LOCAL_MAX_TOKENS", "8000"))
    window = local_context_window(base_url)
    if window:
        ceiling = min(ceiling, max(512, (window - PROMPT_RESERVE) // 2))
    return min(requested, ceiling)


def local_document_budget(base_url: str) -> int | None:  # kept for the health payload
    """Characters of source document a local model can carry in a prompt.

    Roughly four characters per token, spending at most an eighth of the window
    on the document. The rest has to hold the harness, the answer, and the copy
    of both that the agent's next turn re-sends.
    """
    window = local_context_window(base_url)
    return None if not window else max(600, (window // 8) * 4)


def context_window(spec: ModelSpec) -> int | None:
    """The window a role's model actually has, when it can be discovered."""
    if spec.provider == "local":
        return local_context_window(spec.base_url or "")
    if spec.provider == "openrouter":
        return openrouter_context_window(spec.base_url or "", spec.model)
    return None  # Anthropic's windows are far past anything this app sends


def completion_ceiling(spec: ModelSpec, requested: int) -> int:
    """Clamp a request to what this model's window can hold. See the note above."""
    if spec.provider == "anthropic":
        return requested
    ceiling = int(os.getenv("LOCAL_MAX_TOKENS", "8000"))
    window = context_window(spec)
    if window:
        ceiling = min(ceiling, max(512, (window - PROMPT_RESERVE) // 2))
    return min(requested, ceiling)


def document_budget(spec: ModelSpec) -> int | None:
    """Characters of source document this model can carry in a prompt."""
    window = context_window(spec)
    return None if not window else max(600, (window // 8) * 4)


def chat_model(
    role: str, max_tokens: int, structured: bool = True, thinking: bool = True
) -> BaseChatModel:
    """Build the model for a role.

    ``max_tokens`` is what the code would like; a model whose window we can
    discover gets whatever that window can actually afford instead.

    ``structured=False`` also drops the routing directive that pins the request
    to providers honouring a JSON schema — it is the model used after the
    schema turned out not to be servable. ``thinking=False`` asks the provider
    to skip the scratchpad entirely.
    """
    spec = resolve(role)
    return _build(
        spec.provider,
        spec.model,
        spec.base_url,
        completion_ceiling(spec, max_tokens),
        structured=structured,
        thinking=thinking,
    )


def response_strategy(role: str, schema: type):
    """Pick how a role's model is asked for structured output.

    Anthropic returns its best structured output through a forced tool call.
    Local OpenAI-compatible servers usually expose native `json_schema` response
    formats instead, and many refuse — or silently ignore — the forced tool call,
    which surfaces as an agent that finishes with no structured response at all.
    """
    from langchain.agents.structured_output import ProviderStrategy, ToolStrategy

    if resolve(role).provider == "local":
        return ProviderStrategy(schema)
    return ToolStrategy(schema)


# The built-in deep-agent toolbelt costs ~5k prompt tokens in schemas alone.
# Neither of our agents reads files, runs shell commands or keeps a todo list, and
# on a 8-16k local context window that overhead is the difference between an
# extraction that fits and one that truncates mid-JSON.
_UNUSED_BUILTINS = frozenset(
    {"write_todos", "ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"}
)

_harness_configured = False


def configure_harness() -> None:
    """Trim the built-in toolbelt for local models. Idempotent."""
    global _harness_configured
    if _harness_configured:
        return

    from deepagents import (
        GeneralPurposeSubagentProfile,
        HarnessProfile,
        register_harness_profile,
    )

    excluded = set(_UNUSED_BUILTINS)
    if not uses_subagents():
        excluded.add("task")  # nothing to delegate to

    # Keyed on the provider our local models are built with (ChatOpenAI), so an
    # Anthropic role keeps the full harness.
    register_harness_profile(
        "openai",
        HarnessProfile(
            excluded_tools=frozenset(excluded),
            general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False),
        ),
    )
    _harness_configured = True


def missing_requirements() -> list[str]:
    """Human-readable list of what is not configured yet, for the health check."""
    problems = []
    specs = all_specs()
    if any(spec.provider == "anthropic" for spec in specs.values()):
        if not os.getenv("ANTHROPIC_API_KEY"):
            problems.append("ANTHROPIC_API_KEY is missing for the roles using Anthropic.")
    if any(spec.provider == "openrouter" for spec in specs.values()):
        if not os.getenv("OPENROUTER_API_KEY"):
            problems.append("OPENROUTER_API_KEY is missing for the roles using OpenRouter.")
    for spec in specs.values():
        if spec.provider not in PROVIDERS:
            problems.append(f"Unknown provider in {ROLE_ENV[spec.role]}: {spec.provider!r}.")

    return problems


def warnings() -> list[str]:
    """Advisory, not blocking. A cramped window still works, just worse.

    Kept apart from `missing_requirements` on purpose: refusing to start over a
    small context window would be a worse failure than the truncated answers it
    is warning about. It also keeps the blocking check free of network calls.
    """
    notes: list[str] = []
    seen: set[str] = set()
    for spec in all_specs().values():
        window = context_window(spec)
        if not window or window >= RECOMMENDED_CONTEXT or spec.label in seen:
            continue
        seen.add(spec.label)
        notes.append(
            f"{spec.label} is served with a {window}-token context window. The agent "
            f"scaffolding fills much of it, so answers will be short and may truncate. "
            f"Give it {RECOMMENDED_CONTEXT} or more."
        )
    return notes


def uses_subagents() -> bool:
    """Small local models rarely survive orchestrating three subagents.

    Default: on for Anthropic, off for local. ``EXPANDER_SUBAGENTS=1|0`` overrides.
    """
    override = os.getenv("EXPANDER_SUBAGENTS", "").strip().lower()
    if override in {"1", "true", "yes"}:
        return True
    if override in {"0", "false", "no"}:
        return False
    return resolve("expander").provider == "anthropic"
