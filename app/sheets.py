import json
import re
import logging
import os
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger("ionia.sheets")


class GoogleSheetsWriter:
    def __init__(
        self,
        sheet_id: Optional[str] = None,
        credentials_file: Optional[str] = None,
        credentials_json: Optional[str] = None,
        games_range: Optional[str] = None,
        streams_range: Optional[str] = None,
        activations_range: Optional[str] = None,
        dedupe_range: Optional[str] = None,
        validation_keys_range: Optional[str] = None,
        teams_range: Optional[str] = None,
        players_range: Optional[str] = None,
    ) -> None:
        self.sheet_id = sheet_id or os.getenv("IONIA_GOOGLE_SHEET_ID", "").strip()
        self.credentials_json = credentials_json or os.getenv(
            "IONIA_GOOGLE_CREDENTIALS_JSON", ""
        ).strip()
        self.credentials_file = credentials_file or os.getenv(
            "IONIA_GOOGLE_CREDENTIALS_FILE", ""
        ).strip()
        self.games_range = games_range or os.getenv(
            "IONIA_SHEETS_GAMES_RANGE", "games!A:Z"
        )
        self.streams_range = streams_range or os.getenv(
            "IONIA_SHEETS_STREAMS_RANGE", "streams!A:Z"
        )
        self.activations_range = activations_range or os.getenv(
            "IONIA_SHEETS_ACTIVATIONS_RANGE", "activations!A:Z"
        )
        self.dedupe_range = dedupe_range or os.getenv(
            "IONIA_SHEETS_DEDUPE_RANGE", "dedupe!A:Z"
        )
        self.validation_keys_range = validation_keys_range or os.getenv(
            "IONIA_SHEETS_VALIDATION_KEYS_RANGE", "validation_keys!A:Z"
        )
        self.teams_range = teams_range or os.getenv("IONIA_SHEETS_TEAMS_RANGE", "teams!A:Z")
        self.players_range = players_range or os.getenv(
            "IONIA_SHEETS_PLAYERS_RANGE", "players!A:Z"
        )
        self._service = None
        self._enabled = bool(self.sheet_id and (self.credentials_json or self.credentials_file))
        if not self._enabled:
            logger.info("Google Sheets writer disabled; missing sheet id or credentials")

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _get_service(self):
        if not self._enabled:
            return None
        if self._service is not None:
            return self._service
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
        except ImportError as exc:
            logger.error("Google Sheets dependencies missing: %s", exc)
            self._enabled = False
            return None
        try:
            if self.credentials_json:
                payload = json.loads(self.credentials_json)
                credentials = service_account.Credentials.from_service_account_info(
                    payload,
                    scopes=["https://www.googleapis.com/auth/spreadsheets"],
                )
            else:
                credentials = service_account.Credentials.from_service_account_file(
                    self.credentials_file,
                    scopes=["https://www.googleapis.com/auth/spreadsheets"],
                )
            self._service = build("sheets", "v4", credentials=credentials)
            return self._service
        except Exception as exc:
            logger.error("Failed to initialize Google Sheets client: %s", exc)
            self._enabled = False
            return None

    def _get_rows(self, range_name: str) -> List[List[str]]:
        service = self._get_service()
        if service is None:
            return []
        try:
            result = (
                service.spreadsheets()
                .values()
                .get(spreadsheetId=self.sheet_id, range=range_name)
                .execute()
            )
            return result.get("values", [])
        except Exception as exc:
            logger.error("Failed to read rows from %s: %s", range_name, exc)
            return []

    def _append_row(self, range_name: str, row: List[str]) -> Optional[int]:
        service = self._get_service()
        if service is None:
            return None
        for attempt in range(3):
            try:
                result = service.spreadsheets().values().append(
                    spreadsheetId=self.sheet_id,
                    range=range_name,
                    valueInputOption="RAW",
                    body={"values": [row]},
                ).execute()
                updated_range = result.get("updates", {}).get("updatedRange", "")
                return _extract_row_index(updated_range)
            except Exception as exc:
                logger.error(
                    "Failed to append row to %s (attempt %s): %s",
                    range_name,
                    attempt + 1,
                    exc,
                )
                if attempt < 2:
                    from time import sleep

                    sleep(0.25 * (2**attempt))
        return None

    def _update_row(self, range_name: str, row_index: int, row: List[str]) -> bool:
        service = self._get_service()
        if service is None:
            return False
        sheet_name = _extract_sheet_name(range_name)
        if not sheet_name:
            logger.error("Failed to update row; could not infer sheet name from %s", range_name)
            return False
        end_column = _column_letter(len(row))
        target_range = f"{sheet_name}!A{row_index}:{end_column}{row_index}"
        for attempt in range(3):
            try:
                service.spreadsheets().values().update(
                    spreadsheetId=self.sheet_id,
                    range=target_range,
                    valueInputOption="RAW",
                    body={"values": [row]},
                ).execute()
                return True
            except Exception as exc:
                logger.error(
                    "Failed to update row %s in %s (attempt %s): %s",
                    row_index,
                    sheet_name,
                    attempt + 1,
                    exc,
                )
                if attempt < 2:
                    from time import sleep

                    sleep(0.25 * (2**attempt))
        return False

    def append_game_row(self, row: List[str]) -> Optional[int]:
        return self._append_row(self.games_range, row)

    def update_game_row(self, row_index: int, row: List[str]) -> bool:
        return self._update_row(self.games_range, row_index, row)

    def append_stream_event(
        self, team_id: str, event_type: str, payload: Dict[str, Any]
    ) -> Optional[int]:
        timestamp = datetime.now(timezone.utc).isoformat()
        row = [
            timestamp,
            team_id,
            event_type,
            json.dumps(payload, separators=(",", ":"), sort_keys=True),
        ]
        return self._append_row(self.streams_range, row)

    def append_activation_row(
        self,
        api_key: str,
        team_id: str,
        label: str,
        active: bool,
        created_at: str,
        revoked_at: str,
        validation_key: str,
    ) -> Optional[int]:
        row = [
            api_key,
            team_id,
            label,
            str(active).lower(),
            created_at,
            revoked_at,
            validation_key,
        ]
        return self._append_row(self.activations_range, row)

    def append_dedupe_row(self, dedupe_key: str, created_at: str) -> Optional[int]:
        row = [dedupe_key, created_at]
        return self._append_row(self.dedupe_range, row)

    def load_activation_state(self) -> "ActivationState":
        rows = self._get_rows(self.activations_range)
        state = ActivationState()
        for row in rows:
            if len(row) < 2:
                continue
            api_key = row[0]
            team_id = row[1]
            label = row[2] if len(row) > 2 else ""
            active = row[3].lower() == "true" if len(row) > 3 else True
            revoked_at = row[5] if len(row) > 5 else ""
            validation_key = row[6] if len(row) > 6 else ""
            if active and api_key and team_id:
                state.api_keys[api_key] = team_id
            if validation_key:
                state.used_keys.add(validation_key)
            if label == "revoked" or revoked_at:
                state.revoked_keys.add(api_key)
        return state

    def load_validation_keys(self) -> "ValidationKeyState":
        rows = self._get_rows(self.validation_keys_range)
        state = ValidationKeyState()
        for row in rows:
            if len(row) < 2:
                continue
            key = row[0]
            team_id = row[1]
            if not key or not team_id:
                continue
            state.validation_keys[key] = team_id
            if len(row) > 2 and row[2]:
                try:
                    state.validation_key_expires[key] = int(row[2])
                except ValueError:
                    logger.warning("Invalid expires value for key %s", key)
            if len(row) > 3 and row[3].lower() == "true":
                state.revoked_keys.add(key)
        return state

    def append_team_row(
        self, team_id: str, team_tricode: str, team_name: str, league: str
    ) -> Optional[int]:
        row = [team_id, team_tricode, team_name, league]
        return self._append_row(self.teams_range, row)

    def append_player_row(
        self, player_id: str, team_id: str, role: str, player_name: str
    ) -> Optional[int]:
        row = [player_id, team_id, role, player_name]
        return self._append_row(self.players_range, row)

    def load_dedupe_keys(self) -> List[str]:
        rows = self._get_rows(self.dedupe_range)
        keys: List[str] = []
        for row in rows:
            if not row:
                continue
            keys.append(row[0])
        return keys


def _extract_sheet_name(range_name: str) -> str:
    if "!" not in range_name:
        return ""
    return range_name.split("!", 1)[0]


def _column_letter(index: int) -> str:
    if index <= 0:
        return "A"
    letters = []
    while index:
        index, remainder = divmod(index - 1, 26)
        letters.append(chr(65 + remainder))
    return "".join(reversed(letters))


def _extract_row_index(updated_range: str) -> Optional[int]:
    if "!" not in updated_range:
        return None
    cell_range = updated_range.split("!", 1)[1]
    match = re.search(r"([A-Z]+)(\d+)", cell_range)
    if not match:
        return None
    return int(match.group(2))


@dataclass
class ActivationState:
    api_keys: Dict[str, str] = None
    used_keys: set = None
    revoked_keys: set = None

    def __post_init__(self) -> None:
        if self.api_keys is None:
            self.api_keys = {}
        if self.used_keys is None:
            self.used_keys = set()
        if self.revoked_keys is None:
            self.revoked_keys = set()


@dataclass
class ValidationKeyState:
    validation_keys: Dict[str, str] = None
    validation_key_expires: Dict[str, int] = None
    revoked_keys: set = None

    def __post_init__(self) -> None:
        if self.validation_keys is None:
            self.validation_keys = {}
        if self.validation_key_expires is None:
            self.validation_key_expires = {}
        if self.revoked_keys is None:
            self.revoked_keys = set()
