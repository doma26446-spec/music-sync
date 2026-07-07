import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import (
    WebAppInfo, InlineKeyboardMarkup, InlineKeyboardButton,
    MenuButtonWebApp, Message,
)

import config
import state

BASE_DIR = Path(__file__).parent
TRACKS_DIR = BASE_DIR / "static" / "tracks"
TRACKS_DIR.mkdir(parents=True, exist_ok=True)


# ---------- helpers ----------
async def broadcast(room, msg):
    for c in list(room["clients"]):
        try:
            await c.send_json(msg)
        except Exception:
            room["clients"].discard(c)


async def play_specific(room, track):
    room["playing"] = track
    room["paused"] = False
    room["paused_position"] = 0.0
    room["started_at"] = time.time() + 3.0
    room["queue"] = [t for t in room["queue"] if t["id"] != track["id"]]
    await broadcast(room, {
        "action": "play",
        "track": track,
        "startedAt": room["started_at"],
    })


async def start_playback(room):
    if room["playing"] or not room["queue"]:
        return
    track = room["queue"].pop(0)
    await play_specific(room, track)


async def heartbeat():
    while True:
        await asyncio.sleep(2)
        for code, room in list(state.rooms.items()):
            if room["clients"]:
                await broadcast(room, {"action": "state", **state.public_state(room)})


# ---------- FastAPI ----------
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="Открыть плеер",
                web_app=WebAppInfo(url=config.WEBAPP_URL),
            )
        )
    except Exception as e:
        print(f"menu button setup failed: {e}")
    asyncio.create_task(dp.start_polling(bot))
    asyncio.create_task(heartbeat())
    yield


app = FastAPI(title="MUSIC sync bot", lifespan=lifespan)
app.mount("/tracks", StaticFiles(directory=TRACKS_DIR), name="tracks")

bot = Bot(token=config.BOT_TOKEN)
dp = Dispatcher()
user_room = {}


# ---------- WebSocket ----------
@app.websocket("/ws/{room_code}")
async def ws_endpoint(websocket: WebSocket, room_code: str):
    room = state.get_room(room_code)
    if not room:
        room = state.create_room()
    await websocket.accept()
    room["clients"].add(websocket)
    try:
        await websocket.send_json({"action": "state", **state.public_state(room)})
        while True:
            data = await websocket.receive_json()
            a = data.get("action")

            if a == "state":
                await websocket.send_json({"action": "state", **state.public_state(room)})

            elif a == "next":
                room["playing"] = None
                room["paused"] = False
                room["paused_position"] = 0.0
                room["started_at"] = None
                await start_playback(room)
                await broadcast(room, {"action": "state", **state.public_state(room)})

            elif a == "play_track":
                tid = data.get("trackId")
                tr = next((t for t in room["tracks"] if t["id"] == tid), None)
                if tr:
                    await play_specific(room, tr)
                    await broadcast(room, {"action": "state", **state.public_state(room)})

            elif a == "pause":
                if room["playing"] and not room["paused"]:
                    room["paused"] = True
                    room["paused_position"] = time.time() - room["started_at"]
                    await broadcast(room, {"action": "state", **state.public_state(room)})

            elif a == "resume":
                if room["playing"] and room["paused"]:
                    room["paused"] = False
                    room["started_at"] = time.time() - room["paused_position"]
                    await broadcast(room, {"action": "state", **state.public_state(room)})

            elif a == "seek":
                pos = max(0.0, float(data.get("position", 0)))
                if room["playing"]:
                    room["started_at"] = time.time() - pos
                    if room["paused"]:
                        room["paused_position"] = pos
                    await broadcast(room, {"action": "state", **state.public_state(room)})

            elif a == "track_ended":
                room["playing"] = None
                room["paused"] = False
                room["paused_position"] = 0.0
                room["started_at"] = None
                await start_playback(room)
                await broadcast(room, {"action": "state", **state.public_state(room)})

    except WebSocketDisconnect:
        room["clients"].discard(websocket)


# ---------- REST ----------
@app.get("/api/room/{room_code}")
async def api_room(room_code: str):
    room = state.get_room(room_code)
    if not room:
        return JSONResponse({"error": "not found"}, status_code=404)
    return state.public_state(room)


@app.post("/api/demo/{room_code}")
async def api_demo(room_code: str):
    room = state.get_room(room_code)
    if not room:
        room = state.create_room()
    track = {"id": "demo", "name": "demo.wav", "url": "/tracks/demo.wav"}
    state.add_track(room, track)
    await start_playback(room)
    await broadcast(room, {"action": "state", **state.public_state(room)})
    return {"ok": True}


# ---------- Bot ----------
def open_button(code: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🎵 Открыть плеер", web_app=WebAppInfo(url=f"{config.WEBAPP_URL}?room={code}"))
    ]])


@dp.message(Command("start"))
async def cmd_start(message: Message):
    await message.answer(
        "Привет! Я синхро-плеер.\n"
        "/create — создать комнату\n"
        "/join <КОД> — зайти в комнату друга\n"
        "/open — открыть плеер\n"
        "/queue — что в очереди\n\n"
        "После входа пришли мне аудио — оно встанет в плейлист и "
        "заиграет одновременно у всех участников."
    )


@dp.message(Command("create"))
async def cmd_create(message: Message):
    room = state.create_room()
    user_room[message.from_user.id] = room["code"]
    await message.answer(
        f"Комната создана! Код: <b>{room['code']}</b>\n"
        "Дай его другу, чтобы он ввёл /join " + room["code"],
        reply_markup=open_button(room["code"]),
    )


@dp.message(Command("join"))
async def cmd_join(message: Message):
    args = message.text.split()
    if len(args) < 2:
        await message.answer("Укажи код: /join АБВГДЕ")
        return
    code = args[1]
    room = state.get_room(code)
    if not room:
        await message.answer("Комната не найдена.")
        return
    user_room[message.from_user.id] = room["code"]
    await message.answer("Ты в комнате!", reply_markup=open_button(room["code"]))


@dp.message(Command("open"))
async def cmd_open(message: Message):
    code = user_room.get(message.from_user.id)
    if not code:
        await message.answer("Сначала /create или /join <КОД>")
        return
    await message.answer("Открывай:", reply_markup=open_button(code))


@dp.message(Command("queue"))
async def cmd_queue(message: Message):
    code = user_room.get(message.from_user.id)
    if not code:
        await message.answer("Ты не в комнате.")
        return
    room = state.get_room(code)
    lines = [f"🎶 Играет: {room['playing']['name']}" if room['playing'] else "Ничего не играет"]
    lines += [f"{i+1}. {t['name']}" for i, t in enumerate(room['queue'])]
    await message.answer("\n".join(lines))


@dp.message(F.audio | F.voice | F.document)
async def on_audio(message: Message):
    code = user_room.get(message.from_user.id)
    if not code:
        await message.answer("Сначала /create или /join <КОД>")
        return
    room = state.get_room(code)

    if message.audio:
        file_id = message.audio.file_id
        name = message.audio.file_name or message.audio.title or f"track_{uuid.uuid4().hex[:4]}.mp3"
    elif message.voice:
        file_id = message.voice.file_id
        name = f"voice_{uuid.uuid4().hex[:4]}.ogg"
    elif message.document and message.document.mime_type and message.document.mime_type.startswith("audio"):
        file_id = message.document.file_id
        name = message.document.file_name or f"track_{uuid.uuid4().hex[:4]}.mp3"
    else:
        await message.answer("Это не аудиофайл.")
        return

    safe = "".join(c for c in name if c.isalnum() or c in "._-")
    path = TRACKS_DIR / f"{uuid.uuid4().hex[:8]}_{safe}"
    await bot.download_file((await bot.get_file(file_id)).file_path, path)

    track = {"id": uuid.uuid4().hex[:8], "name": safe, "url": f"/tracks/{path.name}"}
    state.add_track(room, track)
    await message.answer(f"✅ Добавлено (всего треков: {len(room['tracks'])})")
    if not room["paused"]:
        await start_playback(room)
    await broadcast(room, {"action": "state", **state.public_state(room)})


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
