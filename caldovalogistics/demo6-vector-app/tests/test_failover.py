from typing import Any

import pytest

from knowledge_hub.failover import API_VERSION, ClusterFailover, FailoverRefused

CLUSTER = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.HorizonDB/clusters/caldova-logistics"


class FakeToken:
    token = "token-123"


class FakeCredential:
    def get_token(self, *scopes: str) -> FakeToken:
        assert scopes == ("https://management.azure.com/.default",)
        return FakeToken()


class FakeAzure:
    def __init__(self, replicas: list[tuple[str, str, str]]) -> None:
        self.replicas = replicas
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def __call__(self, method: str, url: str, token: str, body: dict[str, Any] | None) -> dict[str, Any]:
        assert token == "token-123"
        self.calls.append((method, url, body))
        if method == "GET":
            return {"value": [{"name": name, "properties": {"role": role, "availabilityZone": zone}}
                              for name, role, zone in self.replicas]}
        return {}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(replicas: list[tuple[str, str, str]]) -> tuple[ClusterFailover, FakeAzure, Clock]:
    azure, clock = FakeAzure(replicas), Clock()
    return ClusterFailover(CLUSTER, FakeCredential(), azure, clock, cooldown_seconds=300), azure, clock


def test_force_sets_the_primary_replica_to_read() -> None:
    failover, azure, _ = make([("replica-1", "ReadWrite", "2"), ("replica-ha", "Read", "3")])

    result = failover.force()

    method, url, body = azure.calls[-1]
    assert method == "PATCH" and body == {"properties": {"role": "Read"}}
    assert url == f"https://management.azure.com{CLUSTER}/pools/DefaultPool/replicas/replica-1?api-version={API_VERSION}"
    assert result["from_zone"] == "2" and result["to_zones"] == ["3"]


def test_second_failover_within_the_cooldown_is_refused() -> None:
    failover, azure, clock = make([("replica-1", "ReadWrite", "2"), ("replica-ha", "Read", "3")])
    failover.force()
    clock.now += 60

    with pytest.raises(FailoverRefused) as refused:
        failover.force()

    assert refused.value.status == 429 and "241 s" in refused.value.message
    assert sum(method == "PATCH" for method, _, _ in azure.calls) == 1
    clock.now += 300
    failover.force()
    assert sum(method == "PATCH" for method, _, _ in azure.calls) == 2


@pytest.mark.parametrize("replicas, text", [
    ([("replica-1", "ReadWrite", "2")], "no standby"),
    ([("replica-1", "Read", "2"), ("replica-ha", "Read", "3")], "No primary"),
])
def test_failover_is_refused_when_it_cannot_work(replicas: list[tuple[str, str, str]], text: str) -> None:
    failover, azure, _ = make(replicas)

    with pytest.raises(FailoverRefused) as refused:
        failover.force()

    assert refused.value.status == 409 and text in refused.value.message
    assert all(method == "GET" for method, _, _ in azure.calls)


def test_ready_in_counts_down_the_cooldown() -> None:
    failover, _, clock = make([("replica-1", "ReadWrite", "2"), ("replica-ha", "Read", "3")])
    assert failover.ready_in() == 0
    failover.force()
    clock.now += 100
    assert failover.ready_in() == 200
    clock.now += 200
    assert failover.ready_in() == 0

