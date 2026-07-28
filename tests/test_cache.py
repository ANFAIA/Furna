"""Tests for the document store: the fingerprint and what hangs off it.

Everything the app knows about a document — its text, its entity inventory,
every expansion — is filed under one 16-character hash. These pin the two
properties that makes it worth anything: the same text always produces the same
fingerprint, and the fingerprint alone is enough to get the document back.
"""

from __future__ import annotations



def test_the_fingerprint_ignores_how_the_text_was_pasted():
    """CRLF and trailing blanks are an accident of the editor, not a document."""
    from app.cache import doc_hash

    assert doc_hash("# Title\r\n\r\nBody.  \n") == doc_hash("# Title\n\nBody.")


def test_different_text_is_a_different_document():
    from app.cache import doc_hash

    assert doc_hash("# Title\n\nBody.") != doc_hash("# Title\n\nBody!")


def test_a_document_can_be_brought_back_from_its_fingerprint(tmp_path):
    """The point of the whole feature: 16 characters restore everything."""
    from app.cache import Cache, doc_hash

    store = Cache(tmp_path)
    text = "# Title\n\nBody."
    doc = doc_hash(text)
    store.remember_document(doc, text, source="https://example.com/a", title="Title")

    restored = store.document(doc)
    assert restored["document"] == text
    assert restored["source"] == "https://example.com/a"
    assert restored["title"] == "Title"


def test_an_unknown_fingerprint_returns_nothing(tmp_path):
    from app.cache import Cache

    assert Cache(tmp_path).document("0123456789abcdef") is None


def test_clearing_the_cache_keeps_the_document(tmp_path):
    """Clearing means 'read it again', not 'forget what I was reading'."""
    from app.cache import Cache, ENTITIES_KEY, doc_hash

    store = Cache(tmp_path)
    text = "# Title\n\nBody."
    doc = doc_hash(text)
    store.remember_document(doc, text)
    store.put(doc, "model", ENTITIES_KEY, {"entities": []})
    store.put(doc, "model", "qat@brief", {"title": "QAT"})

    assert store.clear(doc) == 2
    assert store.get(doc, "model", "qat@brief") is None
    assert store.document(doc)["document"] == text


def test_re_analyzing_a_pasted_copy_keeps_where_it_came_from(tmp_path):
    from app.cache import Cache, doc_hash

    store = Cache(tmp_path)
    text = "# Title\n\nBody."
    doc = doc_hash(text)
    store.remember_document(doc, text, source="https://example.com/a")
    store.remember_document(doc, text)  # pasted this time, no source known

    assert store.document(doc)["source"] == "https://example.com/a"


def test_documents_are_listed_most_recent_first(tmp_path):
    import os
    from app.cache import Cache

    store = Cache(tmp_path)
    store.remember_document("aaaa", "first")
    store.remember_document("bbbb", "second")
    # mtime resolution is coarse enough that two writes can tie; make it explicit.
    path = tmp_path / "bbbb" / "__source__" / "document.txt"
    os.utime(path, (path.stat().st_atime + 10, path.stat().st_mtime + 10))

    assert [entry["doc_hash"] for entry in store.documents()] == ["bbbb", "aaaa"]
