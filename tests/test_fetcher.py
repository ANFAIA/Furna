"""Tests for reading a document off the web.

The server fetches whatever URL a link carries, so most of what matters here is
what it refuses. A guard that is only checked by hand is a guard that quietly
stops working.
"""

from __future__ import annotations

import pytest

from app import fetcher
from app.fetcher import FetchError, fetch_document, html_to_text


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://example.com/",
        "ftp://example.com/doc.txt",
        "javascript:alert(1)",
        "/etc/passwd",
    ],
)
def test_only_http_urls_are_read(url):
    with pytest.raises(FetchError, match="http"):
        fetch_document(url)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",  # the server itself
        "169.254.169.254",  # the cloud metadata endpoint
        "10.0.0.5",  # a private network
        "192.168.1.1",
        "::1",
    ],
)
def test_a_private_address_is_refused(address, monkeypatch):
    """A shared link must not be able to aim the server at its own network."""
    monkeypatch.delenv("FURNA_ALLOW_PRIVATE_FETCH", raising=False)
    with pytest.raises(FetchError, match="not a public address"):
        fetcher._check_public(address)


def test_the_private_guard_can_be_lifted_for_local_documents(monkeypatch):
    monkeypatch.setenv("FURNA_ALLOW_PRIVATE_FETCH", "1")
    fetcher._check_public("127.0.0.1")  # no raise


def test_a_public_address_passes(monkeypatch):
    monkeypatch.delenv("FURNA_ALLOW_PRIVATE_FETCH", raising=False)
    fetcher._check_public("93.184.216.34")  # no raise


def test_a_redirect_target_is_checked_too(monkeypatch):
    """A public host may redirect inward; the first check is not enough."""
    monkeypatch.delenv("FURNA_ALLOW_PRIVATE_FETCH", raising=False)
    checked: list[str] = []

    def record(host):
        checked.append(host)
        if host == "internal.local":
            raise FetchError(f"{host} resolves to 10.0.0.1, which is not a public address.")

    monkeypatch.setattr(fetcher, "_check_public", record)
    monkeypatch.setattr(
        fetcher._no_redirect_opener,
        "open",
        lambda request, timeout=None: (_ for _ in ()).throw(
            fetcher.urllib.error.HTTPError(
                request.full_url,
                302,
                "Found",
                {"Location": "http://internal.local/secret"},  # type: ignore[arg-type]
                None,
            )
        ),
    )
    with pytest.raises(FetchError, match="not a public address"):
        fetcher._open("http://example.com/doc")
    assert checked == ["example.com", "internal.local"]


# --------------------------------------------------------------------------- #
# What arrives once a fetch succeeds
# --------------------------------------------------------------------------- #


class FakeHeaders:
    def __init__(self, content_type: str, charset: str | None = "utf-8") -> None:
        self._type, self._charset = content_type, charset

    def get_content_type(self):
        return self._type

    def get_content_charset(self):
        return self._charset


class FakeResponse:
    def __init__(self, body: bytes, content_type: str) -> None:
        self._body, self.headers = body, FakeHeaders(content_type)

    def read(self, size=None):
        return self._body[:size] if size else self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def serve(monkeypatch, body: bytes, content_type: str = "text/plain") -> None:
    monkeypatch.setattr(
        fetcher, "_open", lambda url: (FakeResponse(body, content_type), url)
    )


def test_plain_text_arrives_untouched(monkeypatch):
    serve(monkeypatch, b"# Title\n\nA paragraph.", "text/markdown")
    assert fetch_document("http://example.com/d.md")["document"] == "# Title\n\nA paragraph."


def test_a_page_is_reduced_to_its_prose(monkeypatch):
    serve(
        monkeypatch,
        b"<html><head><title>Doc</title><style>p{color:red}</style></head>"
        b"<body><h1>Heading</h1><p>First.</p><script>evil()</script><p>Second.</p></body></html>",
        "text/html",
    )
    result = fetch_document("http://example.com/")
    assert result["title"] == "Doc"
    assert result["document"] == "# Heading\n\nFirst.\n\nSecond."
    assert "evil" not in result["document"] and "color:red" not in result["document"]


def test_a_binary_download_is_not_a_document(monkeypatch):
    serve(monkeypatch, b"%PDF-1.7", "application/pdf")
    with pytest.raises(FetchError, match="not a text document"):
        fetch_document("http://example.com/paper.pdf")


def test_an_oversized_document_is_refused_rather_than_truncated(monkeypatch):
    """Truncating would analyze half a document without saying so."""
    serve(monkeypatch, b"x" * (fetcher.MAX_DOCUMENT_BYTES + 1))
    with pytest.raises(FetchError, match="larger than"):
        fetch_document("http://example.com/huge.txt")


def test_a_page_whose_text_is_built_in_the_browser_says_so(monkeypatch):
    serve(monkeypatch, b"<html><body><div id='root'></div></body></html>", "text/html")
    with pytest.raises(FetchError, match="build its text in the browser"):
        fetch_document("http://example.com/app")


def test_list_items_survive_as_a_list():
    text, _ = html_to_text("<ul><li>one</li><li>two</li></ul>")
    assert text == "- one\n- two"  # tight, as a list should render


def test_a_page_that_marks_its_main_content_loses_its_menus():
    text, _ = html_to_text(
        "<body><div>Home About Contact</div>"
        f"<main><p>{'The real article. ' * 30}</p></main></body>"
    )
    assert text.startswith("The real article.")
    assert "Home About Contact" not in text


def test_a_token_main_element_is_ignored():
    """Some templates open a <main> and build the article beside it."""
    text, _ = html_to_text(f"<body><main><p>Skip to content</p></main><p>{'Body. ' * 30}</p></body>")
    assert "Body." in text


def test_empty_navigation_bullets_are_dropped():
    """Wikipedia arrives with several hundred before its first sentence."""
    text, _ = html_to_text("<ul><li><span></span></li><li>Real</li></ul>")
    assert text == "- Real"


def test_a_body_that_stalls_midway_is_a_fetch_error(monkeypatch):
    """The connection can succeed and then hang; a 500 tells the reader nothing."""

    class Stalling(FakeResponse):
        def read(self, size=None):
            raise TimeoutError("The read operation timed out")

    monkeypatch.setattr(fetcher, "_open", lambda url: (Stalling(b"", "text/plain"), url))
    with pytest.raises(FetchError, match="stopped arriving"):
        fetch_document("http://example.com/slow.txt")
