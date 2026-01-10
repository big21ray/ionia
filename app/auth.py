import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Optional, Set, Tuple

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger("ionia.auth")


@dataclass
class AuthConfig:
    validation_keys: Dict[str, str] = field(default_factory=dict)
    api_keys: Dict[str, str] = field(default_factory=dict)
    validation_key_expires: Dict[str, int] = field(default_factory=dict)
    revoked_keys: Set[str] = field(default_factory=set)
    used_keys: Set[str] = field(default_factory=set)
    admin_bearer: Optional[str] = None


def _load_json_mapping(env_name: str) -> Dict[str, str]:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("%s is not valid JSON; expected object mapping strings", env_name)
        return {}
    if not isinstance(data, dict):
        logger.error("%s must be a JSON object mapping strings", env_name)
        return {}
    mapping: Dict[str, str] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str):
            mapping[key] = value
        else:
            logger.warning("%s contains a non-string entry for %s; skipping", env_name, key)
    return mapping


def _load_json_int_mapping(env_name: str) -> Dict[str, int]:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("%s is not valid JSON; expected object mapping to ints", env_name)
        return {}
    if not isinstance(data, dict):
        logger.error("%s must be a JSON object mapping to ints", env_name)
        return {}
    mapping: Dict[str, int] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, int):
            mapping[key] = value
        else:
            logger.warning("%s contains a non-int entry for %s; skipping", env_name, key)
    return mapping


def _load_json_set(env_name: str) -> Set[str]:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return set()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("%s is not valid JSON; expected array of strings", env_name)
        return set()
    if not isinstance(data, list):
        logger.error("%s must be a JSON array of strings", env_name)
        return set()
    return {item for item in data if isinstance(item, str)}


def load_auth_config() -> AuthConfig:
    validation_keys = _load_json_mapping("IONIA_VALIDATION_KEYS")
    api_keys = _load_json_mapping("IONIA_API_KEYS")
    validation_key_expires = _load_json_int_mapping("IONIA_VALIDATION_KEYS_EXPIRES")
    revoked_keys = _load_json_set("IONIA_VALIDATION_KEYS_REVOKED")
    admin_bearer = os.getenv("IONIA_ADMIN_BEARER", "").strip() or None
    return AuthConfig(
        validation_keys=validation_keys,
        api_keys=api_keys,
        validation_key_expires=validation_key_expires,
        revoked_keys=revoked_keys,
        admin_bearer=admin_bearer,
    )


def validate_activation_key(config: AuthConfig, key: str) -> Tuple[Optional[str], Optional[str]]:
    if key in config.used_keys:
        return None, "validation key already used"
    if key in config.revoked_keys:
        return None, "validation key revoked"
    team_id = config.validation_keys.get(key)
    if not team_id:
        return None, "invalid or expired validation key"
    expires_at = config.validation_key_expires.get(key)
    if expires_at is not None:
        now = int(datetime.now(timezone.utc).timestamp())
        if now >= expires_at:
            return None, "validation key expired"
    config.used_keys.add(key)
    config.validation_keys.pop(key, None)
    return team_id, None


def _find_existing_bearer(api_keys: Dict[str, str], team_id: str) -> Optional[str]:
    for bearer, mapped_team in api_keys.items():
        if mapped_team == team_id:
            return bearer
    return None


def issue_bearer_for_team(config: AuthConfig, team_id: str) -> str:
    existing = _find_existing_bearer(config.api_keys, team_id)
    if existing:
        return existing
    bearer = f"{team_id.lower()}_{uuid.uuid4().hex}"
    config.api_keys[bearer] = team_id
    return bearer


def resolve_team_id(config: AuthConfig, bearer: str) -> Optional[str]:
    return config.api_keys.get(bearer)


def is_admin_bearer(config: AuthConfig, bearer: str) -> bool:
    if not config.admin_bearer:
        return False
    return bearer == config.admin_bearer


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: AuthConfig, public_paths: Optional[Set[str]] = None):
        super().__init__(app)
        self.config = config
        self.public_paths = public_paths or set()

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if (
            path in self.public_paths
            or path.startswith("/docs")
            or path.startswith("/openapi")
            or path.startswith("/redoc")
        ):
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"error": "missing bearer token"})

        bearer = auth_header.replace("Bearer ", "", 1).strip()
        if not bearer:
            return JSONResponse(status_code=401, content={"error": "missing bearer token"})

        if path.startswith("/admin/"):
            if not self.config.admin_bearer:
                return JSONResponse(
                    status_code=503, content={"error": "admin bearer not configured"}
                )
            if not is_admin_bearer(self.config, bearer):
                return JSONResponse(status_code=401, content={"error": "invalid admin bearer"})
            request.state.is_admin = True
            return await call_next(request)

        team_id = resolve_team_id(self.config, bearer)
        if not team_id:
            return JSONResponse(status_code=401, content={"error": "invalid bearer token"})

        request.state.team_id = team_id
        request.state.bearer = bearer
        return await call_next(request)


def require_team_id(request: Request) -> str:
    team_id = getattr(request.state, "team_id", None)
    if not team_id:
        raise HTTPException(status_code=401, detail="unauthorized")
    return team_id


def require_admin(request: Request) -> None:
    if not getattr(request.state, "is_admin", False):
        raise HTTPException(status_code=401, detail="unauthorized")
