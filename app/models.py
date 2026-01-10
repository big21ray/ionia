from enum import Enum
from typing import Dict, Optional

from pydantic import BaseModel, Field


class Ack(BaseModel):
    status: str = Field(default="ok")


class ErrorResponse(BaseModel):
    error: str


class GameIdResponse(BaseModel):
    game_id: str


class GameSessionResponse(BaseModel):
    status: str = Field(default="ok")
    message: Optional[str] = None
    game_id: Optional[str] = None
    game_number: Optional[int] = None


class ActivationRequest(BaseModel):
    validation_key: str
    machine_fingerprint: str
    app_version: str


class ActivationResponse(BaseModel):
    bearer: str
    team_id: str


class HeartbeatRequest(BaseModel):
    player_id: str
    role: str
    version: str


class ChampSelectStartRequest(BaseModel):
    date: str
    opposite_team: str
    patch: str
    tr: str
    side: str


class DraftCompleteRequest(BaseModel):
    game_id: str
    draft: Dict[str, str]


class GameStartRequest(BaseModel):
    game_id: str
    positions: Dict[str, str]


class GameFinishedRequest(BaseModel):
    game_id: str
    win: str


class StreamRole(str, Enum):
    TOP = "TOP"
    JUNGLE = "JUNGLE"
    MID = "MID"
    ADC = "ADC"
    SUPPORT = "SUPPORT"
    GLOBAL = "GLOBAL"


class StreamPlatform(str, Enum):
    SERVER = "server"
    YOUTUBE = "youtube"


class StreamReadyRequest(BaseModel):
    game_id: str
    role: StreamRole
    vod_url: str
    platform: StreamPlatform
    player_id: Optional[str] = None


class TeamCreateRequest(BaseModel):
    team_tricode: str
    team_name: str
    league: str


class TeamCreateResponse(BaseModel):
    team_id: str


class PlayerCreateRequest(BaseModel):
    team_tricode: str
    role: str
    player_name: str


class PlayerCreateResponse(BaseModel):
    player_id: str
