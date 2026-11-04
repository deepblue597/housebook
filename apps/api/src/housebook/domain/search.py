"""Search matching (DESIGN 15.9). Golden cases: contract/fixtures/search_cases.json.

- Query split on whitespace; every token must match some field (AND).
- Case- and accent-insensitive (`text.fold`), substring matching.
- Model, serial and error codes also match with separators removed (`FD041200123`).
- Each token scores the best tier it hits; an item's score is the sum over tokens (lower is
  better). Ties: name starts with the query, then name, then id.
"""

from dataclasses import dataclass, field

from housebook.domain.text import compact, fold

TIER_NAME = 1
TIER_ERROR_CODE = 2
TIER_MODEL_BRAND = 3  # model, brand, serial
TIER_TYPE_ROOM = 4  # catalogue type label, room name
TIER_BODY = 5


@dataclass(frozen=True)
class SearchDoc:
    id: str
    name: str = ""
    error_codes: tuple[str, ...] = ()
    model: str = ""
    brand: str = ""
    serial: str = ""
    type_label: str = ""
    room: str = ""
    body: str = ""
    _tiers: tuple[tuple[int, str, str], ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        def f(tier: int, value: str, with_compact: bool = False) -> tuple[int, str, str]:
            return tier, fold(value), compact(value) if with_compact else ""

        tiers = [f(TIER_NAME, self.name)]
        tiers += [f(TIER_ERROR_CODE, c, True) for c in self.error_codes]
        tiers += [
            f(TIER_MODEL_BRAND, self.model, True),
            f(TIER_MODEL_BRAND, self.brand),
            f(TIER_MODEL_BRAND, self.serial, True),
            f(TIER_TYPE_ROOM, self.type_label),
            f(TIER_TYPE_ROOM, self.room),
            f(TIER_BODY, self.body),
        ]
        object.__setattr__(self, "_tiers", tuple(t for t in tiers if t[1]))


def tokens(query: str) -> list[str]:
    return [t for t in fold(query).split() if t]


def score(doc: SearchDoc, query: str) -> int | None:
    """Sum of best tiers per token, or None if some token doesn't match."""
    total = 0
    for tok in tokens(query):
        tok_c = compact(tok)
        best = None
        for tier, folded, compacted in doc._tiers:
            if tok in folded or (compacted and tok_c and tok_c in compacted):
                best = tier
                break  # tiers are ordered, first hit is the best
        if best is None:
            return None
        total += best
    return total


def search(docs: list[SearchDoc], query: str) -> list[str]:
    """Ids of matching docs, best first. An empty query matches nothing."""
    if not tokens(query):
        return []
    q = fold(query).strip()
    hits = []
    for doc in docs:
        s = score(doc, query)
        if s is not None:
            hits.append((s, 0 if fold(doc.name).startswith(q) else 1, fold(doc.name), doc.id))
    hits.sort()
    return [h[3] for h in hits]
