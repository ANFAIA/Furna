"""Fetch a document the reader points at by URL.

The browser cannot do this itself — a cross-origin page will not hand its text
to a script on another host — so the server fetches on its behalf. That makes
the server an HTTP client aimed by whoever opens the link, which is the whole
reason this module is careful:

- only `http` and `https`, so `file:///etc/passwd` and `gopher://` are not doors;
- the resolved address must be public, so a shared link cannot make the server
  read `169.254.169.254` or something on the operator's LAN;
- every redirect hop is re-checked, since a public host may redirect inward;
- the body is capped and the wait is bounded.

`FURNA_ALLOW_PRIVATE_FETCH=1` lifts the address check for reading documents off
localhost during development. It is off by default, and it should stay off on
any instance more than one person can reach.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

MAX_DOCUMENT_BYTES = 2_000_000
MAX_REDIRECTS = 4
TIMEOUT_SECONDS = 15

#: Anything that is not prose is a download, not a document.
READABLE_TYPES = ("text/", "application/xhtml", "application/json", "application/xml")

USER_AGENT = "Furna/0.1 (document reader; +https://github.com/)"


class FetchError(Exception):
    """A fetch that failed for a reason worth showing the reader verbatim."""


def _allows_private() -> bool:
    return os.getenv("FURNA_ALLOW_PRIVATE_FETCH", "").strip().lower() in {"1", "true", "yes"}


def _check_public(host: str) -> None:
    """Refuse a host that resolves anywhere but the public internet.

    Resolution happens here and the connection happens later, so this is not
    airtight against a name that changes answers between the two (DNS
    rebinding). It stops the ordinary cases — a link naming `localhost`, an
    internal name, a literal private address — which is what a reader pasting
    URLs actually runs into.
    """
    if _allows_private():
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchError(f"Could not resolve {host}.") from exc

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global or address.is_multicast:
            raise FetchError(
                f"{host} resolves to {address}, which is not a public address. "
                "Set FURNA_ALLOW_PRIVATE_FETCH=1 to read local documents."
            )


def _validated(url: str) -> urllib.parse.ParseResult:
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise FetchError("Only http and https URLs can be read.")
    if not parts.hostname:
        raise FetchError("That URL has no host.")
    _check_public(parts.hostname)
    return parts


def _open(url: str):
    """Walk the redirect chain by hand so every hop is checked, not just the first."""
    seen = url
    for _ in range(MAX_REDIRECTS + 1):
        parts = _validated(seen)
        request = urllib.request.Request(
            urllib.parse.urlunsplit(parts),
            headers={"User-Agent": USER_AGENT, "Accept": "text/*, application/xhtml+xml"},
        )
        try:
            response = _no_redirect_opener.open(request, timeout=TIMEOUT_SECONDS)
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                seen = urllib.parse.urljoin(seen, exc.headers["Location"])
                continue
            raise FetchError(f"The document could not be read: HTTP {exc.code}.") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise FetchError(f"The document could not be reached: {exc}.") from exc
        return response, seen
    raise FetchError("Too many redirects.")


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Surface redirects as errors so `_open` can re-check the target host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_no_redirect_opener = urllib.request.build_opener(_NoRedirects)


class _Textifier(HTMLParser):
    """Reduce a web page to the prose in it.

    Deliberately crude: no boilerplate stripping, no readability heuristics. It
    keeps headings as markdown so the reader still sees the document's shape,
    and drops script, style and the rest of the machinery. Pages that hide
    their text behind JavaScript will arrive nearly empty, and there is no
    fixing that without a browser.
    """

    SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "form"}
    BLOCK = {"p", "div", "section", "article", "br", "tr", "ul", "ol", "table", "pre", "blockquote"}
    HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "h5": "##### ", "h6": "###### "}

    #: When a page says where its content is, believe it.
    MAIN = {"main", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skipping = 0
        self._in_title = False
        self._main: tuple[int, int] | None = None  # slice of `parts` inside <main>
        self._main_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.MAIN:
            if self._main_depth == 0 and self._main is None:
                self._main = (len(self.parts), len(self.parts))
            self._main_depth += 1
        if tag in self.SKIP:
            self._skipping += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.HEADINGS:
            self.parts.append("\n\n" + self.HEADINGS[tag])
        elif tag in self.BLOCK:
            self.parts.append("\n\n")
        elif tag == "li":
            self.parts.append("\n- ")

    def handle_endtag(self, tag):
        if tag in self.MAIN and self._main_depth:
            self._main_depth -= 1
            if self._main_depth == 0 and self._main is not None:
                self._main = (self._main[0], len(self.parts))
        if tag in self.SKIP:
            self._skipping = max(0, self._skipping - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in self.HEADINGS or tag in self.BLOCK:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skipping and data.strip():
            self.parts.append(re.sub(r"\s+", " ", data))

    @property
    def text(self) -> str:
        parts = self.parts
        # A page that marks its own <main> saves the reader its menus. Ignored
        # when it holds almost nothing, since some templates open a <main> and
        # then build the article beside it.
        if self._main is not None:
            inside = self.parts[self._main[0] : self._main[1]]
            if len("".join(inside).strip()) > 400:
                parts = inside
        body = "".join(parts)
        # A page's navigation is mostly lists of links wrapped in icons and
        # spans, which leave a bullet with nothing after it. Wikipedia arrives
        # with several hundred of them before its first sentence.
        body = re.sub(r"^-[ \t]*$\n?", "", body, flags=re.MULTILINE)
        return re.sub(r"\n{3,}", "\n\n", body).strip()


def html_to_text(html: str) -> tuple[str, str]:
    """Return the page's prose and its `<title>`."""
    parser = _Textifier()
    parser.feed(html)
    parser.close()
    return parser.text, " ".join(parser.title.split())


def _decode(raw: bytes, charset: str | None) -> str:
    for encoding in (charset, "utf-8", "cp1252"):
        if not encoding:
            continue
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def fetch_document(url: str) -> dict[str, str]:
    """Read a document from the web. Blocking — call it off the event loop."""
    response, final_url = _open(url)
    with response:
        content_type = (response.headers.get_content_type() or "").lower()
        if not content_type.startswith(READABLE_TYPES):
            raise FetchError(
                f"That URL serves {content_type or 'an unknown type'}, which is not a text "
                "document. Furna reads pages, markdown and plain text."
            )
        try:
            raw = response.read(MAX_DOCUMENT_BYTES + 1)
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            # The connection can succeed and then stall mid-body. Without this
            # the reader gets a 500 and no idea which host was slow.
            raise FetchError(f"The document stopped arriving partway through: {exc}.") from exc
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise FetchError(
                f"The document is larger than {MAX_DOCUMENT_BYTES // 1000}kB. "
                "Paste the part you want to read instead."
            )
        body = _decode(raw, response.headers.get_content_charset())

    title = ""
    if content_type in ("text/html", "application/xhtml+xml"):
        body, title = html_to_text(body)

    if not body.strip():
        raise FetchError(
            "Nothing readable came back — the page may build its text in the browser, "
            "which this fetch cannot run."
        )
    return {"document": body, "url": final_url, "title": title, "content_type": content_type}
