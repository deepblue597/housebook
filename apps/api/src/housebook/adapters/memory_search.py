"""In-memory SearchIndex (D9): a linear scan is milliseconds for a few hundred notes."""

from collections.abc import Iterable

from housebook.domain.search import SearchDoc, search


class MemorySearchIndex:
    def __init__(self, docs: Iterable[SearchDoc]) -> None:
        self.docs = list(docs)

    def search(self, query: str) -> list[str]:
        return search(self.docs, query)
