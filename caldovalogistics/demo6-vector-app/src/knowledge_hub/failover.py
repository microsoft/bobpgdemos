"""Force a HorizonDB failover from the app (step 5 of the walkthrough).

Uses the documented Azure Resource Manager call (there is no az horizondb
failover command yet): the ReadWrite replica is set to Read, so the primary
goes down at once and a standby in another availability zone is promoted.
The app authenticates with its managed identity (DefaultAzureCredential, so
`az login` works when running locally).
"""

from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

API_VERSION = "2026-01-20-preview"
ARM = "https://management.azure.com"
SCOPE = "https://management.azure.com/.default"
COOLDOWN_SECONDS = 300


class FailoverRefused(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class TokenCredential(Protocol):
    def get_token(self, *scopes: str) -> Any: ...


Http = Callable[[str, str, str, dict[str, Any] | None], dict[str, Any]]


def _http(method: str, url: str, token: str, body: dict[str, Any] | None) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode() or "{}"
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        raise FailoverRefused(502, f"Azure refused the request ({error.code}): {detail}") from error
    return json.loads(text)


class ClusterFailover:
    def __init__(self, cluster_id: str, credential: TokenCredential | None = None, http: Http = _http,
                 clock: Callable[[], float] = time.monotonic, cooldown_seconds: int = COOLDOWN_SECONDS) -> None:
        self._replicas_url = f"{ARM}{cluster_id.rstrip('/')}/pools/DefaultPool/replicas"
        self._credential = credential
        self._http = http
        self._clock = clock
        self._cooldown = cooldown_seconds
        self._lock = threading.Lock()
        self._last_request = float("-inf")

    def _token(self) -> str:
        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        return self._credential.get_token(SCOPE).token

    def replicas(self, token: str | None = None) -> list[dict[str, Any]]:
        payload = self._http("GET", f"{self._replicas_url}?api-version={API_VERSION}", token or self._token(), None)
        return [
            {"name": item["name"], "role": item["properties"].get("role"), "zone": item["properties"].get("availabilityZone")}
            for item in payload.get("value", [])
        ]

    def ready_in(self) -> int:
        """Seconds until another failover is allowed (0 when allowed now)."""
        remaining = self._last_request + self._cooldown - self._clock()
        return max(0, math.ceil(remaining)) if remaining > 0 else 0

    def force(self) -> dict[str, Any]:
        """Force a failover. Raises FailoverRefused when it is not safe or allowed now."""
        with self._lock:
            wait = self._last_request + self._cooldown - self._clock()
            if wait > 0:
                raise FailoverRefused(429, f"A failover was requested recently. Try again in {int(wait) + 1} s.")
            token = self._token()
            replicas = self.replicas(token)
            primary = next((replica for replica in replicas if replica["role"] == "ReadWrite"), None)
            standbys = [replica for replica in replicas if replica["role"] == "Read"]
            if primary is None:
                raise FailoverRefused(409, "No primary replica right now; a failover may already be in progress.")
            if not standbys:
                raise FailoverRefused(409, "The cluster has no standby replica to fail over to.")
            self._http("PATCH", f"{self._replicas_url}/{primary['name']}?api-version={API_VERSION}", token,
                       {"properties": {"role": "Read"}})
            self._last_request = self._clock()
        return {
            "requested_at": datetime.now(UTC).isoformat(),
            "from_zone": primary["zone"],
            "to_zones": sorted({replica["zone"] for replica in standbys if replica["zone"]}),
        }
