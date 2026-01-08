import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional, List, Set
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from app.auth import (
    BearerAuthMiddleware,
    issue_bearer_for_team,
    load_auth_config,
    require_team_id,
    validate_activation_key,
)
from app.models import (
    Ack,
    ActivationRequest,
    ActivationResponse,
    ChampSelectStartRequest,
    DraftCompleteRequest,
    GameFinishedRequest,
    GameIdResponse,
    GameSessionResponse,
    GameStartRequest,
    HeartbeatRequest,
    StreamReadyRequest,
)
from app.sheets import GoogleSheetsWriter

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ionia.api")

auth_config = load_auth_config()
sheets_writer = GoogleSheetsWriter()

GAMES_COLUMNS = [
    "game_id",
    "date",
    "opposite_team",
    "game_number",
    "patch",
    "tr",
    "side",
    "win",
    "BB1",
    "BB2",
    "BB3",
    "BP1",
    "BP2",
    "BP3",
    "BB4",
    "BB5",
    "BP4",
    "BP5",
    "RB1",
    "RB2",
    "RB3",
    "RP1",
    "RP2",
    "RP3",
    "RB4",
    "RB5",
    "RP4",
    "RP5",
    "BT",
    "BJ",
    "BM",
    "BA",
    "BS",
    "RT",
    "RJ",
    "RM",
    "RA",
    "RS",
]

GAME_COLUMNS_SET = set(GAMES_COLUMNS)
POSITION_COLUMNS = {"BT", "BJ", "BM", "BA", "BS", "RT", "RJ", "RM", "RA", "RS"}


@dataclass
class DraftCache:
    game_id: str
    draft_count: int
    row_index: Optional[int]
    row_data: Dict[str, str]
    game_number: int
    date: str


draft_cache: Dict[str, DraftCache] = {}
game_counters: Dict[str, Dict[str, int]] = {}
event_dedupe: Set[str] = set()

if sheets_writer.enabled:
    activation_state = sheets_writer.load_activation_state()
    if activation_state.api_keys:
        auth_config.api_keys.update(activation_state.api_keys)
    if activation_state.used_keys:
        auth_config.used_keys.update(activation_state.used_keys)
    validation_state = sheets_writer.load_validation_keys()
    if validation_state.validation_keys:
        auth_config.validation_keys.update(validation_state.validation_keys)
    if validation_state.validation_key_expires:
        auth_config.validation_key_expires.update(validation_state.validation_key_expires)
    if validation_state.revoked_keys:
        auth_config.revoked_keys.update(validation_state.revoked_keys)
    dedupe_keys = sheets_writer.load_dedupe_keys()
    if dedupe_keys:
        event_dedupe.update(dedupe_keys)

app = FastAPI(
    title="Ionia Ingestion API",
    version="1.1.0",
    description=(
        "API used by Ionia Electron clients and Global Python services "
        "to activate installations, report game lifecycle events, "
        "and attach POV streams."
    ),
)

app.add_middleware(BearerAuthMiddleware, config=auth_config, public_paths={"/activate"})


def _error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": message})


def _generate_game_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    suffix = uuid4().hex[:4]
    return f"g_{stamp}_{suffix}"


def _draft_richness(draft: Dict[str, str]) -> int:
    return len([value for value in draft.values() if value])


def _get_game_counter(team_id: str, date: str) -> int:
    team_counters = game_counters.setdefault(team_id, {})
    team_counters[date] = team_counters.get(date, 0) + 1
    return team_counters[date]


def _build_row(row_data: Dict[str, str]) -> List[str]:
    return [row_data.get(column, "") for column in GAMES_COLUMNS]


def _update_row_data(row_data: Dict[str, str], updates: Dict[str, str]) -> None:
    for key, value in updates.items():
        if key in GAME_COLUMNS_SET:
            row_data[key] = value


def _dedupe_key(*parts: str) -> str:
    return "|".join(parts)


@app.post("/activate", response_model=ActivationResponse)
def activate(payload: ActivationRequest):
    team_id, error_message = validate_activation_key(auth_config, payload.validation_key)
    if not team_id:
        return _error(400, error_message or "invalid or expired validation key")
    bearer = issue_bearer_for_team(auth_config, team_id)
    logger.info("activation ok team=%s machine=%s", team_id, payload.machine_fingerprint)
    activation_row = sheets_writer.append_activation_row(
        api_key=bearer,
        team_id=team_id,
        label="activation",
        active=True,
        created_at=datetime.now(timezone.utc).isoformat(),
        revoked_at="",
        validation_key=payload.validation_key,
    )
    if sheets_writer.enabled and activation_row is None:
        return _error(502, "failed to write activation to sheets")
    return ActivationResponse(bearer=bearer, team_id=team_id)


@app.post("/client/heartbeat", response_model=GameSessionResponse)
def client_heartbeat(
    payload: HeartbeatRequest, team_id: str = Depends(require_team_id)
):
    logger.info("heartbeat team=%s player=%s role=%s", team_id, payload.player_id, payload.role)
    cache = draft_cache.get(team_id)
    if not cache:
        return GameSessionResponse(message="no ongoing game")
    return GameSessionResponse(game_id=cache.game_id, game_number=cache.game_number)


@app.post("/events/champ_select_start", response_model=GameSessionResponse)
def champ_select_start(
    payload: ChampSelectStartRequest, team_id: str = Depends(require_team_id)
):
    cache = draft_cache.get(team_id)
    if cache:
        return GameSessionResponse(
            game_id=cache.game_id,
            game_number=cache.game_number,
            message="game already active",
        )

    game_id = _generate_game_id()
    game_number = _get_game_counter(team_id, payload.date)
    row_data = {
        "game_id": game_id,
        "date": payload.date,
        "opposite_team": payload.opposite_team,
        "game_number": str(game_number),
        "patch": payload.patch,
        "tr": payload.tr,
        "side": payload.side,
    }
    row_index = sheets_writer.append_game_row(_build_row(row_data))
    if sheets_writer.enabled and row_index is None:
        return _error(502, "failed to write game row to sheets")
    draft_cache[team_id] = DraftCache(
        game_id=game_id,
        draft_count=0,
        row_index=row_index,
        row_data=row_data,
        game_number=game_number,
        date=payload.date,
    )
    logger.info("champ_select_start team=%s game=%s", team_id, game_id)
    return GameSessionResponse(game_id=game_id, game_number=game_number)


@app.post("/events/draft_complete", response_model=GameIdResponse)
def draft_complete(
    payload: DraftCompleteRequest, team_id: str = Depends(require_team_id)
):
    cache = draft_cache.get(team_id)
    if not cache or cache.game_id != payload.game_id:
        return _error(400, "no active game for team")

    draft_count = _draft_richness(payload.draft)
    if draft_count <= cache.draft_count:
        return GameIdResponse(game_id=cache.game_id)

    logger.info(
        "draft_complete update team=%s game=%s draft_count=%s",
        team_id,
        cache.game_id,
        draft_count,
    )
    _update_row_data(cache.row_data, payload.draft)
    if cache.row_index is not None:
        updated = sheets_writer.update_game_row(cache.row_index, _build_row(cache.row_data))
        if sheets_writer.enabled and not updated:
            return _error(502, "failed to update game row in sheets")
    else:
        cache.row_index = sheets_writer.append_game_row(_build_row(cache.row_data))
        if sheets_writer.enabled and cache.row_index is None:
            return _error(502, "failed to write game row to sheets")
    cache.draft_count = draft_count
    return GameIdResponse(game_id=cache.game_id)


@app.post("/events/game_start", response_model=Ack)
def game_start(payload: GameStartRequest, team_id: str = Depends(require_team_id)):
    cache = draft_cache.get(team_id)
    if not cache or cache.game_id != payload.game_id:
        return _error(400, "no active game for team")
    dedupe_key = _dedupe_key(team_id, "game_start", payload.game_id)
    if dedupe_key in event_dedupe:
        return _error(409, "duplicate event")
    logger.info("game_start team=%s game=%s", team_id, payload.game_id)
    positions = {key: value for key, value in payload.positions.items() if key in POSITION_COLUMNS}
    _update_row_data(cache.row_data, positions)
    if cache.row_index is not None:
        updated = sheets_writer.update_game_row(cache.row_index, _build_row(cache.row_data))
        if sheets_writer.enabled and not updated:
            return _error(502, "failed to update game row in sheets")
    else:
        cache.row_index = sheets_writer.append_game_row(_build_row(cache.row_data))
        if sheets_writer.enabled and cache.row_index is None:
            return _error(502, "failed to write game row to sheets")
    event_dedupe.add(dedupe_key)
    if sheets_writer.enabled:
        sheets_writer.append_dedupe_row(dedupe_key, datetime.now(timezone.utc).isoformat())
    return Ack()


@app.post("/events/game_finished", response_model=Ack)
def game_finished(payload: GameFinishedRequest, team_id: str = Depends(require_team_id)):
    cache = draft_cache.get(team_id)
    if not cache or cache.game_id != payload.game_id:
        return _error(400, "no active game for team")
    dedupe_key = _dedupe_key(team_id, "game_finished", payload.game_id)
    if dedupe_key in event_dedupe:
        return _error(409, "duplicate event")
    logger.info("game_finished team=%s game=%s", team_id, payload.game_id)
    _update_row_data(cache.row_data, {"win": payload.win})
    if cache.row_index is not None:
        updated = sheets_writer.update_game_row(cache.row_index, _build_row(cache.row_data))
        if sheets_writer.enabled and not updated:
            return _error(502, "failed to update game row in sheets")
    else:
        row_index = sheets_writer.append_game_row(_build_row(cache.row_data))
        if sheets_writer.enabled and row_index is None:
            return _error(502, "failed to write game row to sheets")
    draft_cache.pop(team_id, None)
    event_dedupe.add(dedupe_key)
    if sheets_writer.enabled:
        sheets_writer.append_dedupe_row(dedupe_key, datetime.now(timezone.utc).isoformat())
    return Ack()


@app.post("/events/stream_ready", response_model=Ack)
def stream_ready(payload: StreamReadyRequest, team_id: str = Depends(require_team_id)):
    dedupe_key = _dedupe_key(team_id, "stream_ready", payload.game_id, payload.role.value)
    if dedupe_key in event_dedupe:
        return _error(409, "duplicate event")
    logger.info(
        "stream_ready team=%s game=%s role=%s", team_id, payload.game_id, payload.role
    )
    row_index = sheets_writer.append_stream_event(
        team_id,
        "stream_ready",
        {
            "game_id": payload.game_id,
            "role": payload.role.value,
            "vod_url": payload.vod_url,
            "platform": payload.platform.value,
            "player_id": payload.player_id,
        },
    )
    if sheets_writer.enabled and row_index is None:
        return _error(502, "failed to write stream row to sheets")
    event_dedupe.add(dedupe_key)
    if sheets_writer.enabled:
        sheets_writer.append_dedupe_row(dedupe_key, datetime.now(timezone.utc).isoformat())
    return Ack()


@app.exception_handler(HTTPException)
def http_exception_handler(_: Request, exc: HTTPException):
    return _error(exc.status_code, str(exc.detail))
