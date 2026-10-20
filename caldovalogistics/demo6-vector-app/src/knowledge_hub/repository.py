from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import OrderedDict
from typing import Any

from knowledge_hub.database import Database
from knowledge_hub.models import Article, SearchResult

ARTICLE_COLUMNS = """
    article_id, title, category, content, author, updated_at,
    expected_chunks, embedded_chunks, searchable, refreshing
"""

# Nearest chunks by cosine distance (DiskANN), mapped back to articles through
# searchable_chunk: each article's current version once fully embedded, else
# its previous version while the pipeline refreshes it in the background.
# Vectors for deleted articles or superseded text never match.
VECTOR_CANDIDATES = """
    nearest AS (
        SELECT embedding.chunk_hash,
               embedding.chunk_text,
               embedding.embedding <=> query.vector AS distance
        FROM knowledge_hub.chunk_embedding embedding, query
        ORDER BY embedding.embedding <=> query.vector
        LIMIT 60
    ),
    vector_hits AS (
        SELECT DISTINCT ON (served.article_id)
               served.article_id, served.served_version, nearest.chunk_text, nearest.distance
        FROM nearest
        JOIN knowledge_hub.searchable_chunk served ON served.chunk_hash = nearest.chunk_hash
        ORDER BY served.article_id, nearest.distance
    ),
    vector_ranked AS (
        SELECT vector_hits.*, row_number() OVER (ORDER BY distance) AS vector_rank
        FROM vector_hits
    )
"""

KEYWORD_CANDIDATES = """
    keyword_ranked AS (
        SELECT article.article_id,
               (article.embedding_text <@> to_bm25query(%(query)s, 'knowledge_hub.article_bm25_idx'))::float AS bm25,
               row_number() OVER (
                   ORDER BY article.embedding_text <@> to_bm25query(%(query)s, 'knowledge_hub.article_bm25_idx')
               ) AS keyword_rank
        FROM knowledge_hub.article article
        ORDER BY article.embedding_text <@> to_bm25query(%(query)s, 'knowledge_hub.article_bm25_idx')
        LIMIT 20
    )
"""

VECTOR_SQL = f"""
    WITH query AS MATERIALIZED (SELECT %(vector)s::public.vector AS vector),
    {VECTOR_CANDIDATES}
    SELECT article.article_id, article.title, article.category,
           vector_ranked.chunk_text AS snippet,
           (1 - vector_ranked.distance)::float AS score,
           vector_ranked.vector_rank,
           vector_ranked.served_version
    FROM vector_ranked
    JOIN knowledge_hub.article article ON article.article_id = vector_ranked.article_id
    ORDER BY vector_ranked.vector_rank
    LIMIT 8
"""

KEYWORD_SQL = f"""
    WITH {KEYWORD_CANDIDATES}
    SELECT article.article_id, article.title, article.category,
           left(article.content, 260) AS snippet,
           (-keyword_ranked.bm25)::float AS score,
           keyword_ranked.keyword_rank
    FROM keyword_ranked
    JOIN knowledge_hub.article article ON article.article_id = keyword_ranked.article_id
    ORDER BY keyword_ranked.keyword_rank
    LIMIT 8
"""

# Reciprocal rank fusion (k = 60) of the vector and BM25 rankings.
HYBRID_SQL = f"""
    WITH query AS MATERIALIZED (SELECT %(vector)s::public.vector AS vector),
    {VECTOR_CANDIDATES},
    {KEYWORD_CANDIDATES}
    SELECT article.article_id, article.title, article.category,
           coalesce(vector_ranked.chunk_text, left(article.content, 260)) AS snippet,
           (coalesce(1.0 / (60 + vector_ranked.vector_rank), 0)
            + coalesce(1.0 / (60 + keyword_ranked.keyword_rank), 0))::float AS score,
           vector_ranked.vector_rank,
           keyword_ranked.keyword_rank,
           vector_ranked.served_version
    FROM knowledge_hub.article article
    LEFT JOIN vector_ranked ON vector_ranked.article_id = article.article_id
    LEFT JOIN keyword_ranked ON keyword_ranked.article_id = article.article_id
    WHERE vector_ranked.article_id IS NOT NULL OR keyword_ranked.article_id IS NOT NULL
    ORDER BY score DESC
    LIMIT 8
"""

SCORE_LABELS = {"vector": "cosine similarity", "keyword": "BM25 score", "hybrid": "RRF score"}
SEARCH_SQL = {"vector": VECTOR_SQL, "keyword": KEYWORD_SQL, "hybrid": HYBRID_SQL}


QUERY_CACHE_SIZE = 512
logger = logging.getLogger(__name__)


class KnowledgeHubRepository:
    def __init__(self, database: Database) -> None:
        self._database = database
        # Query text -> embedding. Embeddings depend only on the text and model,
        # so repeated searches skip the Foundry call; results are never cached.
        self._query_vectors: OrderedDict[str, str] = OrderedDict()
        self._query_lock = threading.Lock()

    def _query_vector(self, query: str) -> str:
        with self._query_lock:
            cached = self._query_vectors.get(query)
            if cached is not None:
                self._query_vectors.move_to_end(query)
                return cached
        # azure_ai needs a writable server ("cannot assign TransactionIds during
        # recovery" on a standby), so the query is embedded on the primary; the
        # search itself runs on the read endpoint. Cached vectors keep repeat
        # searches working while the primary fails over.
        with self._database.primary() as connection:
            row = connection.execute(
                "SELECT knowledge_hub.embed_query(%s)::text AS vector", (query,)
            ).fetchone()
        vector = row["vector"]
        with self._query_lock:
            self._query_vectors[query] = vector
            if len(self._query_vectors) > QUERY_CACHE_SIZE:
                self._query_vectors.popitem(last=False)
        return vector

    def list_articles(self) -> list[Article]:
        with self._database.primary() as connection:
            rows = connection.execute(
                f"SELECT {ARTICLE_COLUMNS} FROM knowledge_hub.article_freshness ORDER BY category, title"
            ).fetchall()
        return [Article(**row) for row in rows]

    def get_article(self, article_id: int) -> Article | None:
        with self._database.primary() as connection:
            row = connection.execute(
                f"SELECT {ARTICLE_COLUMNS} FROM knowledge_hub.article_freshness WHERE article_id = %s",
                (article_id,),
            ).fetchone()
        return Article(**row) if row else None

    def save_article(
        self,
        article_id: int | None,
        title: str,
        category: str,
        content: str,
        author: str,
    ) -> int:
        with self._database.primary() as connection:
            row = connection.execute(
                "SELECT knowledge_hub.save_article(%s, %s, %s, %s, %s) AS article_id",
                (article_id, title, category, content, author),
            ).fetchone()
        return int(row["article_id"])

    def delete_article(self, article_id: int) -> bool:
        with self._database.primary() as connection:
            row = connection.execute(
                "SELECT knowledge_hub.delete_article(%s) AS deleted", (article_id,)
            ).fetchone()
        return bool(row["deleted"])

    def reset_demo(self) -> None:
        with self._database.primary() as connection:
            connection.execute("SELECT knowledge_hub.reset_demo()")

    def search(self, query: str, mode: str) -> list[SearchResult]:
        parameters: dict[str, Any] = {"query": query}
        if mode in ("vector", "hybrid"):
            parameters["vector"] = self._query_vector(query)
        with self._database.reader() as connection:
            rows = connection.execute(SEARCH_SQL[mode], parameters).fetchall()
        return [
            SearchResult(
                article_id=row["article_id"],
                title=row["title"],
                category=row["category"],
                snippet=row["snippet"],
                score=float(row["score"]),
                score_label=SCORE_LABELS[mode],
                vector_rank=row.get("vector_rank"),
                keyword_rank=row.get("keyword_rank"),
                served_version=row.get("served_version"),
            )
            for row in rows
        ]

    def pipeline_status(self) -> dict[str, Any]:
        with self._database.primary() as connection:
            row = connection.execute("SELECT knowledge_hub.pipeline_status() AS status").fetchone()
        return row["status"]

    def cluster_status(self) -> dict[str, Any]:
        """Which server is the primary right now.

        The server is reported as an opaque id (not its internal address) so a
        failover is visible as a change of id on this public page.
        """
        with self._database.primary(timeout=3) as connection:
            row = connection.execute(
                """
                SELECT host(inet_server_addr()) AS server,
                       pg_postmaster_start_time() AS started_at
                """
            ).fetchone()
        server = f"{row['server']}|{row['started_at']}"
        return {
            "server_id": hashlib.sha256(server.encode()).hexdigest()[:6],
            "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        }

    def revise_handbook(self) -> dict[str, Any]:
        """Revise all 16 handbook parts in one statement and return the run it started."""
        with self._database.primary(timeout=5) as connection:
            before = connection.execute(
                "SELECT coalesce(max(id), 0) AS id FROM ai.pipeline_runs WHERE pipeline_name = 'knowledge-hub-pipeline'"
            ).fetchone()["id"]
            article_id = connection.execute("SELECT knowledge_hub.revise_handbook() AS id").fetchone()["id"]
            run_id = None
            deadline = time.monotonic() + 5
            while run_id is None and time.monotonic() < deadline:
                row = connection.execute(
                    "SELECT min(id) AS id FROM ai.pipeline_runs WHERE pipeline_name = 'knowledge-hub-pipeline' AND id > %s",
                    (before,),
                ).fetchone()
                run_id = row["id"]
                if run_id is None:
                    time.sleep(0.2)
        return {"article_id": article_id, "run_id": run_id}

    def pipeline_running(self) -> bool:
        with self._database.primary(timeout=3) as connection:
            row = connection.execute(
                """
                SELECT EXISTS (
                    SELECT 1 FROM ai.pipeline_runs
                    WHERE pipeline_name = 'knowledge-hub-pipeline' AND status = 'running'
                ) AS running
                """
            ).fetchone()
        return bool(row["running"])

    def embedding_pending(self) -> bool:
        """True while any current article chunk still waits for its vector.

        Read on the primary: a just-saved article can take a moment to reach
        the read replica, which would otherwise report nothing pending. During
        a failover the primary is briefly unreachable, so fall back to the
        replica quickly instead of holding up the search that asked.
        """
        try:
            with self._database.primary(timeout=2) as connection:
                return self._embedding_pending(connection)
        except Exception:
            with self._database.reader() as connection:
                return self._embedding_pending(connection)

    @staticmethod
    def _embedding_pending(connection: Any) -> bool:
        row = connection.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM knowledge_hub.article_chunk_map map
                WHERE NOT EXISTS (
                    SELECT 1 FROM knowledge_hub.chunk_embedding embedding
                    WHERE embedding.chunk_hash = map.chunk_hash
                      AND embedding.embedding IS NOT NULL
                )
            ) AS pending
            """
        ).fetchone()
        return bool(row["pending"])

    def freshness(self) -> list[dict[str, Any]]:
        with self._database.primary() as connection:
            return connection.execute(
                """
                SELECT article_id, expected_chunks, embedded_chunks, searchable, refreshing
                FROM knowledge_hub.article_freshness
                """
            ).fetchall()

    def vector_index_definition(self) -> str | None:
        with self._database.primary() as connection:
            row = connection.execute(
                """
                SELECT pg_get_indexdef(index_class.oid) AS definition
                FROM pg_class index_class
                JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
                WHERE namespace.nspname = 'knowledge_hub'
                  AND index_class.relname = 'chunk_embedding_diskann_idx'
                """
            ).fetchone()
        return row["definition"] if row else None
