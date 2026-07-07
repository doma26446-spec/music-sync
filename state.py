import time
import uuid

rooms = {}


def create_room():
    code = uuid.uuid4().hex[:6].upper()
    rooms[code] = {
        "code": code,
        "tracks": [],
        "queue": [],
        "playing": None,
        "started_at": None,
        "paused": False,
        "paused_position": 0.0,
        "clients": set(),
    }
    return rooms[code]


def get_room(code):
    if not code:
        return None
    return rooms.get(code.upper())


def add_track(room, track):
    if not any(t["id"] == track["id"] for t in room["tracks"]):
        room["tracks"].append(track)
    room["queue"].append(track)


def public_state(room):
    return {
        "code": room["code"],
        "tracks": room["tracks"],
        "queue": room["queue"],
        "playing": room["playing"],
        "started_at": room["started_at"],
        "paused": room["paused"],
        "paused_position": room["paused_position"],
    }
