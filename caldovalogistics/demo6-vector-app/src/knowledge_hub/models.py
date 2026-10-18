from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

CATEGORIES = ("Handling procedure", "Carrier note", "Facility runbook")
SEARCH_MODES = ("vector", "keyword", "hybrid")


@dataclass(frozen=True)
class Article:
    article_id: int
    title: str
    category: str
    content: str
    author: str
    updated_at: datetime
    expected_chunks: int
    embedded_chunks: int
    searchable: bool
    refreshing: bool = False


@dataclass(frozen=True)
class SearchResult:
    article_id: int
    title: str
    category: str
    snippet: str
    score: float
    score_label: str
    vector_rank: int | None = None
    keyword_rank: int | None = None
    served_version: str | None = None
