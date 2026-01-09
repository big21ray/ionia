from typing import Any

import pytest
from fastapi.testclient import TestClient

import main as main


@pytest.fixture(autouse=True)
def reset_auth_config():
    main.auth_config.validation_keys = {"IONIA-TEST-KEY": "KC"}
    main.auth_config.api_keys = {}
    main.auth_config.validation_key_expires = {}
    main.auth_config.used_keys = set()
    main.auth_config.revoked_keys = set()
    main.draft_cache.clear()
    main.game_counters.clear()
    main.event_dedupe.clear()
    main.sheets_writer._enabled = False
    yield
    main.auth_config.validation_keys = {}
    main.auth_config.api_keys = {}
    main.auth_config.validation_key_expires = {}
    main.auth_config.used_keys = set()
    main.auth_config.revoked_keys = set()
    main.draft_cache.clear()
    main.game_counters.clear()
    main.event_dedupe.clear()
    main.sheets_writer._enabled = False


@pytest.fixture()
def client():
    return TestClient(main.app)


def _activate(client: TestClient) -> str:
    response = client.post(
        "/activate",
        json={
            "validation_key": "IONIA-TEST-KEY",
            "machine_fingerprint": "win-test",
            "app_version": "1.0.0",
        },
    )
    assert response.status_code == 200
    return response.json()["bearer"]


def test_activate_invalid_validation_key(client: TestClient):
    response = client.post(
        "/activate",
        json={
            "validation_key": "INVALID",
            "machine_fingerprint": "win-test",
            "app_version": "1.0.0",
        },
    )
    assert response.status_code == 400
    assert response.json() == {"error": "invalid or expired validation key"}


def test_activate_reused_validation_key_is_rejected(client: TestClient):
    _activate(client)
    response = client.post(
        "/activate",
        json={
            "validation_key": "IONIA-TEST-KEY",
            "machine_fingerprint": "win-test",
            "app_version": "1.0.0",
        },
    )
    assert response.status_code == 400
    assert response.json() == {"error": "validation key already used"}


def test_invalid_bearer_token_rejected(client: TestClient):
    response = client.post(
        "/client/heartbeat",
        json={"player_id": "p1", "role": "MID", "version": "1.0.0"},
        headers={"Authorization": "Bearer not-valid"},
    )
    assert response.status_code == 401
    assert response.json() == {"error": "invalid bearer token"}


def test_champ_select_start_creates_game_and_heartbeat_returns_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    bearer = _activate(client)
    monkeypatch.setattr(main.sheets_writer, "append_game_row", lambda _row: 5)

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["game_id"]
    assert data["game_number"] == 1

    response = client.post(
        "/client/heartbeat",
        json={"player_id": "p1", "role": "MID", "version": "1.0.0"},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    assert response.json()["game_id"] == data["game_id"]


def test_champ_select_start_returns_existing_game(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    bearer = _activate(client)
    monkeypatch.setattr(main.sheets_writer, "append_game_row", lambda _row: 5)

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    game_id = response.json()["game_id"]

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    assert response.json()["game_id"] == game_id
    assert response.json()["message"] == "game already active"


def test_heartbeat_no_ongoing_game(client: TestClient):
    bearer = _activate(client)

    response = client.post(
        "/client/heartbeat",
        json={"player_id": "p1", "role": "MID", "version": "1.0.0"},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    assert response.json()["message"] == "no ongoing game"


def test_richer_draft_updates_row(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    bearer = _activate(client)
    updated = []

    monkeypatch.setattr(main.sheets_writer, "append_game_row", lambda _row: 7)

    def fake_update(row_index: int, row: Any) -> bool:
        updated.append((row_index, row))
        return True

    monkeypatch.setattr(main.sheets_writer, "update_game_row", fake_update)

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    game_id = response.json()["game_id"]

    response = client.post(
        "/events/draft_complete",
        json={"game_id": game_id, "draft": {"BP1": "Maokai"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200

    response = client.post(
        "/events/draft_complete",
        json={"game_id": game_id, "draft": {"BP1": "Maokai"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200

    response = client.post(
        "/events/draft_complete",
        json={"game_id": game_id, "draft": {"BP1": "Maokai", "BP2": "Azir"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200

    assert len(updated) == 2


def test_draft_complete_without_active_game_returns_error(client: TestClient):
    bearer = _activate(client)
    response = client.post(
        "/events/draft_complete",
        json={"game_id": "g_test", "draft": {"BP1": "Maokai"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 400
    assert response.json() == {"error": "no active game for team"}


def test_game_finished_clears_active_game(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    bearer = _activate(client)
    updates = []

    monkeypatch.setattr(main.sheets_writer, "append_game_row", lambda _row: 5)

    def fake_update(row_index: int, row: Any) -> bool:
        updates.append((row_index, row))
        return True

    monkeypatch.setattr(main.sheets_writer, "update_game_row", fake_update)

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    game_id = response.json()["game_id"]

    response = client.post(
        "/events/game_finished",
        json={"game_id": game_id, "win": "W"},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    assert len(updates) == 1

    response = client.post(
        "/client/heartbeat",
        json={"player_id": "p1", "role": "MID", "version": "1.0.0"},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200
    assert response.json()["message"] == "no ongoing game"


def test_missing_game_id_returns_validation_error(client: TestClient):
    bearer = _activate(client)
    response = client.post(
        "/events/game_start",
        json={"positions": {"BM": "Azir"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 422


def test_duplicate_game_start_is_rejected(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    bearer = _activate(client)
    monkeypatch.setattr(main.sheets_writer, "append_game_row", lambda _row: 5)
    monkeypatch.setattr(main.sheets_writer, "update_game_row", lambda _row_index, _row: True)

    response = client.post(
        "/events/champ_select_start",
        json={
            "date": "2026-01-07",
            "opposite_team": "T1",
            "patch": "14.1",
            "tr": "TR1",
            "side": "BLUE",
        },
        headers={"Authorization": f"Bearer {bearer}"},
    )
    game_id = response.json()["game_id"]

    response = client.post(
        "/events/game_start",
        json={"game_id": game_id, "positions": {"BM": "Azir"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 200

    response = client.post(
        "/events/game_start",
        json={"game_id": game_id, "positions": {"BM": "Azir"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )
    assert response.status_code == 409
    assert response.json() == {"error": "duplicate event"}


def test_sheets_write_failure_is_handled(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    bearer = _activate(client)
    main.sheets_writer._enabled = True
    main.draft_cache["KC"] = main.DraftCache(
        game_id="g_test",
        draft_count=0,
        row_index=1,
        row_data={"game_id": "g_test", "date": "2026-01-07", "game_number": "1"},
        game_number=1,
        date="2026-01-07",
    )

    monkeypatch.setattr(main.sheets_writer, "update_game_row", lambda _row_index, _row: False)

    response = client.post(
        "/events/game_start",
        json={"game_id": "g_test", "positions": {"BM": "Azir"}},
        headers={"Authorization": f"Bearer {bearer}"},
    )

    assert response.status_code == 502
    assert response.json() == {"error": "failed to update game row in sheets"}
