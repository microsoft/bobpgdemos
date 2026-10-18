from collections.abc import Iterator
from datetime import UTC, datetime
from contextlib import contextmanager
from typing import Any

from knowledge_hub.repository import HYBRID_SQL, KEYWORD_SQL, VECTOR_SQL, KnowledgeHubRepository


class FakeConnection:
    def __init__(self, calls: list[tuple[str, Any]], status: dict[str, Any] | None = None,
                 pool: str = "primary", pools: list[tuple[str, str]] | None = None) -> None:
        self.calls = calls
        self.status = status
        self.pool = pool
        self.pools = pools if pools is not None else []
        self._rows: list[dict[str, Any]] = []

    def execute(self, sql: str, parameters: Any = None) -> "FakeConnection":
        self.calls.append((sql, parameters))
        self.pools.append((self.pool, sql))
        if "embed_query" in sql:
            self._rows = [{"vector": "[0.1,0.2]"}]
        elif "inet_server_addr" in sql:
            self._rows = [{"server": "10.0.0.5", "started_at": datetime(2026, 10, 18, 11, 59, tzinfo=UTC)}]
        elif "pipeline_status" in sql:
            self._rows = [{"status": self.status}]
        else:
            self._rows = []
        return self

    def fetchone(self) -> dict[str, Any]:
        return self._rows[0]

    def fetchall(self) -> list[dict[str, Any]]:
        return self._rows


class FakeDatabase:
    def __init__(self, status: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.status = status
        self.timeouts: list[float | None] = []
        self.pools: list[tuple[str, str]] = []

    @contextmanager
    def reader(self) -> Iterator[FakeConnection]:
        yield FakeConnection(self.calls, self.status, "reader", self.pools)

    @contextmanager
    def primary(self, timeout: float | None = None) -> Iterator[FakeConnection]:
        self.timeouts.append(timeout)
        yield FakeConnection(self.calls, self.status, "primary", self.pools)


def embed_calls(database: FakeDatabase) -> int:
    return sum("embed_query" in sql for sql, _ in database.calls)


def test_search_sql_never_calls_the_embedding_model_per_row() -> None:
    # Calling embed_query inside the search made PostgreSQL evaluate it per
    # chunk (about 3 s per search); the vector is now passed in once.
    for sql in (VECTOR_SQL, HYBRID_SQL, KEYWORD_SQL):
        assert "embed_query" not in sql
    assert "%(vector)s" in VECTOR_SQL and "%(vector)s" in HYBRID_SQL


def test_query_is_embedded_once_and_cached() -> None:
    database = FakeDatabase()
    repository = KnowledgeHubRepository(database)  # type: ignore[arg-type]

    repository.search("dry ice", "vector")
    repository.search("dry ice", "hybrid")
    repository.search("lithium", "vector")
    repository.search("lithium", "keyword")

    assert embed_calls(database) == 2
    search_parameters = [parameters for sql, parameters in database.calls if "embed_query" not in sql]
    assert search_parameters[0] == {"query": "dry ice", "vector": "[0.1,0.2]"}
    assert search_parameters[-1] == {"query": "lithium"}


def test_pipeline_status_is_read_only() -> None:
    # No reconciler to restart: reading status never writes or starts anything.
    database = FakeDatabase({"runs": []})
    repository = KnowledgeHubRepository(database)  # type: ignore[arg-type]

    assert repository.pipeline_status() == {"runs": []}
    assert [sql for sql, _ in database.calls] == ["SELECT knowledge_hub.pipeline_status() AS status"]


def test_cluster_status_hides_the_server_address_and_fails_fast() -> None:
    database = FakeDatabase()
    repository = KnowledgeHubRepository(database)  # type: ignore[arg-type]

    status = repository.cluster_status()

    assert len(status["server_id"]) == 6 and "10.0.0.5" not in str(status)
    assert status["started_at"] == "2026-10-18T11:59:00+00:00"
    assert set(status) == {"server_id", "started_at"}
    # During a failover the check must not wait for the pool's 30 s default.
    assert database.timeouts == [3]


def test_query_is_embedded_on_the_primary_and_searched_on_the_reader() -> None:
    # A HorizonDB standby rejects azure_ai calls ("cannot assign TransactionIds
    # during recovery"); the vector search itself is read-only.
    database = FakeDatabase()
    repository = KnowledgeHubRepository(database)  # type: ignore[arg-type]

    repository.search("dry ice", "vector")

    assert [pool for pool, sql in database.pools if "embed_query" in sql] == ["primary"]
    assert [pool for pool, sql in database.pools if "embed_query" not in sql] == ["reader"]
