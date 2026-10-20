from __future__ import annotations

import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from knowledge_hub.failover import ClusterFailover, FailoverRefused
from knowledge_hub.models import CATEGORIES, SEARCH_MODES, Article, SearchResult
from knowledge_hub.pipeline_view import STAGES, render_pipeline_sql, summarize

PACKAGE_ROOT = Path(__file__).parent
templates = Jinja2Templates(directory=PACKAGE_ROOT / "templates")
logger = logging.getLogger(__name__)


class Failover(Protocol):
    def force(self) -> dict[str, Any]: ...

    def ready_in(self) -> int: ...


class Repository(Protocol):
    def list_articles(self) -> list[Article]: ...

    def get_article(self, article_id: int) -> Article | None: ...

    def save_article(self, article_id: int | None, title: str, category: str, content: str, author: str) -> int: ...

    def delete_article(self, article_id: int) -> bool: ...

    def reset_demo(self) -> None: ...

    def search(self, query: str, mode: str) -> list[SearchResult]: ...

    def embedding_pending(self) -> bool: ...

    def pipeline_status(self) -> dict[str, Any]: ...

    def cluster_status(self) -> dict[str, Any]: ...

    def pipeline_running(self) -> bool: ...

    def revise_handbook(self) -> dict[str, Any]: ...

    def freshness(self) -> list[dict[str, Any]]: ...

    def vector_index_definition(self) -> str | None: ...


def _home_url(query: str = "", mode: str = "vector", **extra: object) -> str:
    parameters = {key: value for key, value in {"q": query, "mode": mode, **extra}.items() if value not in ("", None)}
    return "/app?" + urlencode(parameters) if parameters else "/app"


def _initial_status(status: dict[str, Any], articles: list[Article]) -> dict[str, Any] | None:
    """Status for the first paint, in the same shape as /api/status."""
    if not status:
        return None
    payload = summarize(status)
    payload["articles"] = [
        {
            "article_id": article.article_id,
            "expected_chunks": article.expected_chunks,
            "embedded_chunks": article.embedded_chunks,
            "searchable": article.searchable,
            "refreshing": article.refreshing,
        }
        for article in articles
    ]
    return payload


def create_app(repository: Repository | None = None, failover: Failover | None = None) -> FastAPI:
    if failover is None and os.environ.get("KNOWLEDGE_HUB_CLUSTER_ID"):
        failover = ClusterFailover(os.environ["KNOWLEDGE_HUB_CLUSTER_ID"])

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database = None
        if repository is None:
            from knowledge_hub.database import Database
            from knowledge_hub.repository import KnowledgeHubRepository

            database = Database()
            database.open()
            app.state.repository = KnowledgeHubRepository(database)
        else:
            app.state.repository = repository
        yield
        if database is not None:
            database.close()

    app = FastAPI(title="Caldova Knowledge Hub", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=PACKAGE_ROOT / "static"), name="static")

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Browsers must revalidate scripts and styles so a redeploy is picked up
        # without a hard refresh (the ETag keeps unchanged files cheap).
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/app", response_class=HTMLResponse)
    def home(
        request: Request,
        q: str = "",
        mode: str = "vector",
        edit: int | None = None,
        new: int = 0,
        watch: int | None = None,
        error: str = "",
    ) -> HTMLResponse:
        current: Repository = request.app.state.repository
        mode = mode if mode in SEARCH_MODES else "vector"
        query = q.strip()[:300]
        results: list[SearchResult] = []
        messages = [error] if error else []
        try:
            articles = current.list_articles()
            if query:
                results = current.search(query, mode)
            status = current.pipeline_status()
            code_lines = render_pipeline_sql(status.get("pipeline"), current.vector_index_definition())
        except Exception:
            logger.exception("Knowledge Hub page failed to load")
            articles, status, code_lines = [], {}, render_pipeline_sql(None, None)
            messages.append("HorizonDB is unavailable. Check the connection settings and firewall, then refresh.")
        editing = next((article for article in articles if article.article_id == edit), None)
        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={
                "query": query,
                "mode": mode,
                "modes": SEARCH_MODES,
                "results": results,
                "articles": articles,
                "categories": CATEGORIES,
                "editing": editing,
                "show_editor": bool(new) or editing is not None,
                "watch": watch,
                "messages": messages,
                "code_lines": code_lines,
                "stages": STAGES,
                "initial_status": _initial_status(status, articles),
                "page": "app",
            },
        )

    @app.get("/walkthrough", include_in_schema=False)
    def walkthrough_redirect() -> RedirectResponse:
        return RedirectResponse("/", status_code=308)

    @app.get("/", response_class=HTMLResponse)
    def walkthrough(request: Request) -> HTMLResponse:
        current: Repository = request.app.state.repository
        messages: list[str] = []
        try:
            articles = current.list_articles()
            status = current.pipeline_status()
            code_lines = render_pipeline_sql(status.get("pipeline"), current.vector_index_definition())
        except Exception:
            logger.exception("Walkthrough page failed to load")
            articles, status, code_lines = [], {}, render_pipeline_sql(None, None)
            messages.append("HorizonDB is unavailable. Check the connection settings and firewall, then refresh.")
        return templates.TemplateResponse(
            request=request,
            name="walkthrough.html",
            context={
                "messages": messages,
                "code_lines": code_lines,
                "stages": STAGES,
                "initial_status": _initial_status(status, articles),
                "page": "walkthrough",
            },
        )

    @app.post("/articles", response_model=None)
    def save_article(
        request: Request,
        title: str = Form(min_length=3, max_length=160),
        category: str = Form(),
        content: str = Form(min_length=20, max_length=20000),
        author: str = Form(default="", max_length=80),
        article_id: int | None = Form(default=None),
        q: str = Form(default=""),
        mode: str = Form(default="vector"),
    ) -> RedirectResponse | JSONResponse:
        # The walkthrough saves without leaving the page.
        wants_json = "application/json" in request.headers.get("accept", "")
        if category not in CATEGORIES:
            if wants_json:
                return JSONResponse({"error": "Choose a valid category."}, status_code=400)
            return RedirectResponse(_home_url(q, mode, error="Choose a valid category."), status_code=303)
        current: Repository = request.app.state.repository
        try:
            saved = current.save_article(article_id, title, category, content, author)
        except Exception:
            logger.exception("Saving article failed")
            if wants_json:
                return JSONResponse({"error": "The article could not be saved."}, status_code=500)
            return RedirectResponse(_home_url(q, mode, error="The article could not be saved."), status_code=303)
        if wants_json:
            return JSONResponse({"article_id": saved})
        return RedirectResponse(_home_url(q, mode, watch=saved), status_code=303)

    @app.post("/articles/{article_id}/delete")
    def delete_article(
        request: Request,
        article_id: int,
        q: str = Form(default=""),
        mode: str = Form(default="vector"),
    ) -> RedirectResponse:
        current: Repository = request.app.state.repository
        try:
            current.delete_article(article_id)
        except Exception:
            logger.exception("Deleting article failed")
            return RedirectResponse(_home_url(q, mode, error="The article could not be deleted."), status_code=303)
        return RedirectResponse(_home_url(q, mode), status_code=303)

    @app.post("/reset")
    def reset(request: Request) -> RedirectResponse:
        current: Repository = request.app.state.repository
        try:
            current.reset_demo()
        except Exception:
            logger.exception("Reset failed")
            return RedirectResponse(_home_url(error="The demo could not be reset."), status_code=303)
        return RedirectResponse("/app", status_code=303)

    @app.get("/api/status")
    def api_status(request: Request) -> JSONResponse:
        current: Repository = request.app.state.repository
        try:
            payload = summarize(current.pipeline_status())
            payload["articles"] = current.freshness()
        except Exception:
            logger.exception("Pipeline status failed")
            return JSONResponse({"error": "HorizonDB is unavailable."}, status_code=503)
        return JSONResponse(payload, headers={"Cache-Control": "no-store"})

    @app.get("/api/cluster")
    def api_cluster(request: Request) -> JSONResponse:
        # Step 5 polls this once a second during a failover: a 503 means the
        # primary is unreachable, a new server_id means a new primary took over.
        current: Repository = request.app.state.repository
        try:
            payload = current.cluster_status()
        except Exception:
            logger.warning("Primary unreachable for /api/cluster", exc_info=True)
            return JSONResponse({"error": "The primary is unreachable."}, status_code=503, headers={"Cache-Control": "no-store"})
        payload["failover_enabled"] = failover is not None
        payload["failover_ready_in"] = failover.ready_in() if failover is not None else None
        return JSONResponse(payload, headers={"Cache-Control": "no-store"})

    @app.post("/api/handbook")
    def api_handbook(request: Request) -> JSONResponse:
        # Step 5, part 1: revise the 16-part handbook in one statement, which starts
        # one long pipeline run (about 320 chunks) for the failover to interrupt.
        if failover is None:
            return JSONResponse({"error": "Failover from the app is not configured."}, status_code=404)
        wait = failover.ready_in()
        if wait:
            return JSONResponse({"error": f"A failover ran recently. Try again in {wait} s."}, status_code=429)
        current: Repository = request.app.state.repository
        try:
            if current.pipeline_running():
                return JSONResponse({"error": "A pipeline run is already in progress. Try again in a moment."}, status_code=409)
            result = current.revise_handbook()
        except Exception:
            logger.exception("Handbook revision failed")
            return JSONResponse({"error": "The handbook could not be updated."}, status_code=503)
        return JSONResponse(result)

    @app.post("/api/failover")
    def api_failover(request: Request) -> JSONResponse:
        # Step 5, part 2: force a real HorizonDB failover while the handbook's run is
        # in the middle of Embed. No sign-in (by choice); one failover per 5 minutes.
        if failover is None:
            return JSONResponse({"error": "Failover from the app is not configured."}, status_code=404)
        try:
            result = failover.force()
        except FailoverRefused as refused:
            return JSONResponse({"error": refused.message}, status_code=refused.status)
        except Exception:
            logger.exception("Failover request failed")
            return JSONResponse({"error": "The failover could not be requested."}, status_code=502)
        logger.warning("Forced failover requested from the app: %s", result)
        return JSONResponse(result, status_code=202)

    @app.get("/api/search")
    def api_search(request: Request, q: str = "", mode: str = "vector", pending: str = "1") -> JSONResponse:
        current: Repository = request.app.state.repository
        mode = mode if mode in SEARCH_MODES else "vector"
        query = q.strip()[:300]
        started = time.perf_counter()
        try:
            results = current.search(query, mode) if query else []
            elapsed_ms = round((time.perf_counter() - started) * 1000)
        except Exception:
            logger.exception("Search failed")
            return JSONResponse({"error": "HorizonDB is unavailable."}, status_code=503)
        # Read right after the search, so each answer says whether the pipeline
        # was still embedding anything at that moment. It is extra information:
        # it must never delay or fail the search (step 5 skips it with pending=0).
        embedding_pending = None
        if pending != "0":
            try:
                embedding_pending = current.embedding_pending()
            except Exception:
                logger.warning("Embedding status unavailable", exc_info=True)
        return JSONResponse(
            {
                "query": query,
                "mode": mode,
                "elapsed_ms": elapsed_ms,
                "embedding_pending": embedding_pending,
                "results": [asdict(result) for result in results],
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
