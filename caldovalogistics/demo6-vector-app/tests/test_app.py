from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from knowledge_hub.app import create_app
from knowledge_hub.failover import FailoverRefused
from knowledge_hub.models import Article, SearchResult
from test_pipeline_view import INDEX, PIPELINE


class FakeRepository:
    def __init__(self) -> None:
        self.saved: list[tuple] = []
        self.deleted: list[int] = []
        self.reset_count = 0
        self.searches: list[tuple[str, str]] = []
        self.fail = False
        self.pending = False
        self.running = False
        self.revisions = 0
        self.articles = [
            Article(1, "Reefer unit failure response", "Handling procedure", "If a refrigerated trailer stops cooling...",
                    "Caldova Operations", datetime(2026, 10, 16, tzinfo=UTC), 2, 2, True),
            Article(2, "Lithium battery acceptance", "Handling procedure", "Shipments containing lithium cells...",
                    "Caldova Operations", datetime(2026, 10, 16, tzinfo=UTC), 1, 0, False),
        ]

    def list_articles(self) -> list[Article]:
        if self.fail:
            raise RuntimeError("database down")
        return self.articles

    def get_article(self, article_id: int) -> Article | None:
        return next((article for article in self.articles if article.article_id == article_id), None)

    def save_article(self, article_id, title, category, content, author) -> int:
        self.saved.append((article_id, title, category, content, author))
        return article_id or 99

    def delete_article(self, article_id: int) -> bool:
        self.deleted.append(article_id)
        return True

    def reset_demo(self) -> None:
        self.reset_count += 1

    def search(self, query: str, mode: str) -> list[SearchResult]:
        self.searches.append((query, mode))
        return [SearchResult(1, "Reefer unit failure response", "Handling procedure", "<b>stops cooling</b>", 0.459,
                             "cosine similarity", vector_rank=1, keyword_rank=None)]

    def pipeline_status(self) -> dict[str, Any]:
        return {
            "checked_at": "2026-10-16T21:00:20+00:00",
            "pipeline": PIPELINE,
            "runs": [{"id": 24, "status": "completed", "rows_processed": 1, "error": None,
                      "started_at": "2026-10-16T21:00:00+00:00", "completed_at": "2026-10-16T21:00:02+00:00",
                      "instance_id": "abc12345"}],
            "nodes": [],
            "freshness": {"articles": 2, "searchable_articles": 1, "expected_chunks": 3, "embedded_chunks": 2},
            "sink_rows": 3,
        }

    def cluster_status(self) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("primary failing over")
        return {"server_id": "3f9a2c", "started_at": "2026-10-08T11:57:03+00:00"}

    def revise_handbook(self) -> dict[str, Any]:
        self.revisions += 1
        return {"article_id": 30, "run_id": 408}

    def pipeline_running(self) -> bool:
        if self.fail:
            raise RuntimeError("primary failing over")
        return self.running

    def freshness(self) -> list[dict[str, Any]]:
        return [{"article_id": 2, "expected_chunks": 1, "embedded_chunks": 1, "searchable": True}]

    def embedding_pending(self) -> bool:
        return self.pending

    def vector_index_definition(self) -> str | None:
        return INDEX


@pytest.fixture
def repository() -> FakeRepository:
    return FakeRepository()


@pytest.fixture
def client(repository: FakeRepository) -> TestClient:
    with TestClient(create_app(repository)) as test_client:
        yield test_client


def test_home_shows_app_and_live_pipeline_side_by_side(client: TestClient) -> None:
    response = client.get("/app")

    assert response.status_code == 200
    body = response.text
    assert "Find the right procedure" in body
    assert 'id="pipeline-pane"' in body
    assert 'aria-expanded="true"' in body
    assert "Searchable · 2 chunks" in body
    assert "Embedding 0/1" in body
    assert "-- Live definition, rendered from ai.pipelines" in body
    for stage in ("source", "chunk", "embed", "sink", "trigger", "index"):
        assert f'data-code-stage="{stage}"' in body
    # Only the built-in pipeline: no custom pg_durable reconciler tab or tile.
    assert "df.loop(" not in body and "reconciler" not in body.lower()
    assert body.count('class="stage"') == 7
    assert '"run_status": "completed"' in body


@pytest.mark.parametrize("mode", ["vector", "keyword", "hybrid"])
def test_search_modes(client: TestClient, repository: FakeRepository, mode: str) -> None:
    response = client.get("/app", params={"q": "truck fridge died", "mode": mode})

    assert response.status_code == 200
    assert repository.searches == [("truck fridge died", mode)]
    assert "Reefer unit failure response" in response.text
    assert "&lt;b&gt;stops cooling&lt;/b&gt;" in response.text
    assert 'mode-tab is-active' in response.text


def test_unknown_mode_falls_back_to_vector(client: TestClient, repository: FakeRepository) -> None:
    client.get("/app", params={"q": "battery", "mode": "drop table"})

    assert repository.searches == [("battery", "vector")]


def test_results_and_articles_show_background_refresh(client: TestClient, repository: FakeRepository) -> None:
    repository.search = lambda query, mode: [  # type: ignore[method-assign]
        SearchResult(1, "Reefer unit failure response", "Handling procedure", "old text", 0.45,
                     "cosine similarity", vector_rank=1, served_version="previous")
    ]
    repository.articles[1] = Article(2, "Lithium battery acceptance", "Handling procedure", "Shipments...",
                                     "Caldova Operations", datetime(2026, 10, 16, tzinfo=UTC), 1, 0, False, True)

    response = client.get("/app", params={"q": "truck fridge", "mode": "vector"})

    assert "Previous version · refreshing" in response.text
    assert "Refreshing · serving previous version" in response.text
    assert "is-refreshing" in response.text


def test_save_article_redirects_to_watch(client: TestClient, repository: FakeRepository) -> None:
    response = client.post(
        "/articles",
        data={"title": "Hazmat placards", "category": "Handling procedure",
              "content": "Confirm placards on all four sides match the papers.", "author": "Ops", "q": "hazmat", "mode": "hybrid"},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "/app?q=hazmat&mode=hybrid&watch=99"
    assert repository.saved == [(None, "Hazmat placards", "Handling procedure", "Confirm placards on all four sides match the papers.", "Ops")]


def test_save_rejects_unknown_category(client: TestClient, repository: FakeRepository) -> None:
    response = client.post(
        "/articles",
        data={"title": "Bad", "category": "Gossip", "content": "This category is not allowed at all."},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert "error=" in response.headers["location"]
    assert repository.saved == []


def test_edit_opens_editor_with_article(client: TestClient) -> None:
    response = client.get("/app", params={"edit": 1})

    assert "Edit article" in response.text
    assert 'name="article_id" value="1"' in response.text
    assert "data-open" in response.text


def test_delete_and_reset(client: TestClient, repository: FakeRepository) -> None:
    assert client.post("/articles/2/delete", follow_redirects=False).status_code == 303
    assert client.post("/reset", follow_redirects=False).status_code == 303

    assert repository.deleted == [2]
    assert repository.reset_count == 1


def test_search_api_returns_json_results(client: TestClient, repository: FakeRepository) -> None:
    response = client.get("/api/search", params={"q": " truck fridge ", "mode": "hybrid"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["query"] == "truck fridge" and payload["mode"] == "hybrid"
    assert isinstance(payload["elapsed_ms"], int)
    assert payload["results"][0]["title"] == "Reefer unit failure response"
    assert set(payload["results"][0]) >= {"article_id", "snippet", "score", "score_label", "served_version"}
    assert payload["embedding_pending"] is False
    repository.pending = True
    assert client.get("/api/search", params={"q": "x"}).json()["embedding_pending"] is True
    assert repository.searches == [("truck fridge", "hybrid"), ("x", "vector")]


def test_search_api_empty_query_and_bad_mode(client: TestClient, repository: FakeRepository) -> None:
    empty = client.get("/api/search", params={"q": "  "}).json()
    fallback = client.get("/api/search", params={"q": "battery", "mode": "drop table"}).json()

    assert empty["query"] == "" and empty["results"] == []
    assert fallback["mode"] == "vector"
    assert repository.searches == [("battery", "vector")]


def test_search_api_reports_outage(client: TestClient, repository: FakeRepository) -> None:
    def fail(query: str, mode: str) -> list[SearchResult]:
        raise RuntimeError("database down")

    repository.search = fail  # type: ignore[method-assign]

    response = client.get("/api/search", params={"q": "battery"})

    assert response.status_code == 503


def test_status_api(client: TestClient) -> None:
    response = client.get("/api/status")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["run"]["id"] == 24
    assert "reconciler" not in payload
    assert payload["articles"] == [{"article_id": 2, "expected_chunks": 1, "embedded_chunks": 1, "searchable": True}]


def test_database_outage_degrades_gracefully(client: TestClient, repository: FakeRepository) -> None:
    repository.fail = True

    response = client.get("/app")

    assert response.status_code == 200
    assert "HorizonDB is unavailable" in response.text


def test_static_assets(client: TestClient) -> None:
    page = client.get("/app", headers={"x-forwarded-proto": "https"})
    script = client.get("/static/app.js")
    stylesheet = client.get("/static/app.css")

    # Relative URLs avoid mixed content behind App Service's TLS front end.
    assert 'href="/static/app.css"' in page.text and 'src="/static/app.js"' in page.text
    assert "http://" not in page.text
    assert script.status_code == 200 and "pg_durable" in script.text and "/api/status" in script.text
    icon = client.get("/static/horizondb.svg")
    assert icon.status_code == 200 and "Azure HorizonDB" in icon.text
    assert 'src="/static/horizondb.svg"' in page.text
    # Keep searching and the Play demo tour were replaced by the walkthrough.
    assert client.get("/static/tour.js").status_code == 404
    assert client.get("/static/live.js").status_code == 404
    assert "data-tour-play" not in page.text and "data-live-toggle" not in page.text
    assert stylesheet.status_code == 200 and ".pipeline-pane" in stylesheet.text and ".walk-step" in stylesheet.text


def test_initial_status_includes_article_freshness(client: TestClient) -> None:
    response = client.get("/app", params={"q": "truck fridge", "mode": "vector"})

    initial = response.text.split('id="initial-status" type="application/json">', 1)[1].split("</script>", 1)[0]
    assert '"articles": [{"article_id": 1' in initial
    assert '"searchable": false' in initial


def test_save_article_returns_json_for_scripts(client: TestClient, repository: FakeRepository) -> None:
    form = {"title": "Hazmat placards", "category": "Handling procedure",
            "content": "Confirm placards on all four sides match the papers."}

    saved = client.post("/articles", data=form, headers={"Accept": "application/json"})
    invalid = client.post("/articles", data={**form, "category": "Gossip"}, headers={"Accept": "application/json"})

    assert saved.status_code == 200 and saved.json() == {"article_id": 99}
    assert invalid.status_code == 400 and "error" in invalid.json()
    assert len(repository.saved) == 1


def test_walkthrough_page_shows_five_steps_one_at_a_time(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    body = response.text
    assert body.count('class="walk-card"') == 5
    for number in range(1, 6):
        assert f'data-step="{number}"' in body
        assert f'data-goto="{number}"' in body
    assert 'data-step="6"' not in body
    # Only step 1 is visible at first.
    assert 'data-step="1" aria-labelledby="step-1-title">' in body
    for number in range(2, 6):
        assert f'data-step="{number}" aria-labelledby="step-{number}-title" hidden>' in body
    assert "data-next" in body and "data-back" in body
    # The app is on the left; the pipeline is on the right, open, and replayed slowly.
    assert 'data-pane-default="open"' in body and 'data-replay-pace="slow"' in body
    assert 'id="pipeline-pane"' in body
    # Step 3 runs on its own and no pipeline progress is drawn on the left.
    assert "Automatic · no click needed" in body
    # Step 5 updates the handbook and fails over mid-run; nothing is simulated.
    assert "Survive a failover mid-run" in body and "Update the handbook and fail over" in body
    for row in ("pipeline", "primary", "search"):
        assert f'data-monitor="{row}"' in body
    assert "data-sim-banner" not in body and "Simulation" not in body and 'data-action="simulate"' not in body
    assert "walk-flow" not in body and "data-replay hidden" not in body and "data-show-pipeline" not in body
    assert "New row" not in body and "Updated row" not in body
    assert 'src="/static/walkthrough.js"' in body and 'src="/static/app.js"' in body
    # The walkthrough is the home page and stands alone: no link to the full app.
    assert 'href="/app"' not in body and "Full app" not in body
    assert "data-tour-play" not in body
    initial = body.split('id="initial-status" type="application/json">', 1)[1].split("</script>", 1)[0]
    assert '"articles": [' in initial


def test_static_files_are_revalidated(client: TestClient) -> None:
    assert client.get("/static/walkthrough.js").headers["cache-control"] == "no-cache"
    assert "cache-control" not in client.get("/health").headers


def test_app_links_to_walkthrough(client: TestClient) -> None:
    assert 'href="/"' in client.get("/app").text


def test_old_walkthrough_url_redirects_home(client: TestClient) -> None:
    response = client.get("/walkthrough", follow_redirects=False)

    assert response.status_code == 308 and response.headers["location"] == "/"


def test_walkthrough_script_is_served(client: TestClient) -> None:
    script = client.get("/static/walkthrough.js")

    assert script.status_code == 200
    assert "/api/search" in script.text and "/api/cluster" in script.text and "/api/handbook" in script.text and "simulateFailover" not in script.text and "kh-walk-cleanup" in script.text


def test_cluster_endpoint_reports_primary_and_pg_durable(client: TestClient) -> None:
    response = client.get("/api/cluster")

    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json()["server_id"] == "3f9a2c"
    assert response.json()["started_at"] == "2026-10-08T11:57:03+00:00"


def test_cluster_endpoint_returns_503_while_the_primary_is_down(client: TestClient, repository: FakeRepository) -> None:
    repository.fail = True

    response = client.get("/api/cluster")

    assert response.status_code == 503 and "unreachable" in response.json()["error"]


class FakeFailover:
    def __init__(self) -> None:
        self.requests = 0
        self.refuse: FailoverRefused | None = None
        self.wait = 0

    def ready_in(self) -> int:
        return self.wait

    def force(self) -> dict[str, Any]:
        if self.refuse:
            raise self.refuse
        self.requests += 1
        return {"requested_at": "2026-10-18T14:40:00+00:00", "from_zone": "2", "to_zones": ["3"]}


@pytest.fixture
def failover() -> FakeFailover:
    return FakeFailover()


@pytest.fixture
def failover_client(repository: FakeRepository, failover: FakeFailover) -> TestClient:
    with TestClient(create_app(repository, failover)) as test_client:
        yield test_client


def test_failover_button_is_offered_only_when_configured(client: TestClient, failover_client: TestClient) -> None:
    assert client.get("/api/cluster").json()["failover_enabled"] is False
    assert failover_client.get("/api/cluster").json()["failover_enabled"] is True
    assert client.post("/api/failover").status_code == 404
    assert 'data-action="failover"' in client.get("/").text


def test_failover_is_forced_from_the_app(failover_client: TestClient, failover: FakeFailover) -> None:
    response = failover_client.post("/api/failover")

    assert response.status_code == 202 and response.json()["from_zone"] == "2"
    assert failover.requests == 1


def test_failover_is_allowed_while_a_pipeline_run_is_in_progress(
        failover_client: TestClient, repository: FakeRepository, failover: FakeFailover) -> None:
    # Step 5 fails over in the middle of the handbook's run on purpose.
    repository.running = True

    assert failover_client.post("/api/failover").status_code == 202
    assert failover.requests == 1


def test_handbook_update_returns_the_run_it_started(failover_client: TestClient, repository: FakeRepository) -> None:
    response = failover_client.post("/api/handbook")

    assert response.status_code == 200 and response.json() == {"article_id": 30, "run_id": 408}
    assert repository.revisions == 1


def test_handbook_update_is_refused_during_the_cooldown_or_a_run(
        failover_client: TestClient, repository: FakeRepository, failover: FakeFailover) -> None:
    failover.wait = 120
    assert failover_client.post("/api/handbook").status_code == 429
    failover.wait = 0
    repository.running = True
    assert failover_client.post("/api/handbook").status_code == 409
    assert repository.revisions == 0
    assert failover_client.get("/api/cluster").json()["failover_ready_in"] == 0


def test_handbook_update_needs_failover_configured(client: TestClient, repository: FakeRepository) -> None:
    assert client.post("/api/handbook").status_code == 404
    assert repository.revisions == 0


def test_failover_cooldown_is_passed_through(failover_client: TestClient, failover: FakeFailover) -> None:
    failover.refuse = FailoverRefused(429, "A failover was requested recently. Try again in 200 s.")

    response = failover_client.post("/api/failover")

    assert response.status_code == 429 and "200 s" in response.json()["error"]

