import os, json, asyncio, base64
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from openai import OpenAI
import websockets




client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
app = FastAPI()


PLANNER_MODEL = os.environ.get("PLANNER_MODEL", "gpt-4o")
EXECUTOR_MODEL = os.environ.get("EXECUTOR_MODEL", "gpt-4o-mini")




class AgentStep(BaseModel):
    controllerPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class PlanReq(BaseModel):
    controllerPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class ExecuteReq(BaseModel):
    executorPrompt: str
    goalText: str
    step: dict
    meta: dict


class StatusReq(BaseModel):
    statusPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class SummarizeReq(BaseModel):
    question: str = "Summarize the page."
    screenshotDataUrl: str




class IntentReq(BaseModel):
    text: str




def format_history(meta):
    if isinstance(meta, dict):
        hist = meta.get("actionHistory")
        if isinstance(hist, list):
            return "\n".join(hist)
    return ""




def format_elements(meta, limit=120):
    if not isinstance(meta, dict):
        return ""
    elements = meta.get("elements")
    if not isinstance(elements, list):
        return ""
    lines = []
    for el in elements[:limit]:
        idx = el.get("index")
        role = el.get("role") or ""
        name = (el.get("accessibleName") or "").strip()
        text = (el.get("innerText") or "").strip()
        placeholder = (el.get("placeholder") or "").strip()
        region = el.get("region") or {}
        horiz = region.get("horizontal") or ""
        vert = region.get("vertical") or ""
        bbox = el.get("bbox") or {}
        line = (
            f"{idx} | role:{role} | name:{name[:60]} | text:{text[:60]} "
            f"| placeholder:{placeholder[:40]} | region:{vert}/{horiz} "
            f"| bbox:({bbox.get('x')},{bbox.get('y')},{bbox.get('w')},{bbox.get('h')})"
        )
        lines.append(line)
    return "\n".join(lines)




def format_recent_actions(meta, limit=10):
    if not isinstance(meta, dict):
        return ""
    recent = meta.get("recentActions")
    if not isinstance(recent, list):
        return ""
    return "\n".join([str(x) for x in recent[:limit]])


def format_trimmed_history(meta, limit=5):
    if not isinstance(meta, dict):
        return ""
    hist = meta.get("actionHistory")
    if not isinstance(hist, list):
        return ""
    return "\n".join([str(x) for x in hist[-limit:]])




@app.post("/agent-step")
def agent_step(req: AgentStep):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)




    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""




    rules_text = (
        "ELEMENTS RULE: Prefer matching by accessibleName / innerText / placeholder / role over visuals alone.\n"
        "ACTION_HISTORY RULE: Treat ACTION_HISTORY as completed steps; don’t repeat unless the UI changed or the last attempt failed.\n"
        "AMBIGUITY RULE: If multiple overlays could match, pick the single best visible match using nearby text/icon context. "
        "Use ask_user ONLY when there is no clear target or when required info is missing from the UI.\n"
        "ASK USER RULE: If any required value (names, emails, phone, address, etc.) is missing from the UI or USER_REPLY, "
        "do not guess. Immediately return {\"action\":\"ask_user\",\"value\":\"<concise question>\"}. Do NOT invent personal data.\n"
        "EMAIL RULE: Never fabricate an email. If not provided, ask_user.\n"
    )




    user_text = (
        f"{rules_text}\n"
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"ELEMENTS:\n{elements_text}"
    )




    try:
        resp = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.controllerPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/plan")
def plan(req: PlanReq):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)


    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    last_error = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""
        last_error = req.meta.get("lastError") or ""


    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"ELEMENTS:\n{elements_text}\n\n"
        f"NOTES:\n{last_error}"
    )


    try:
        resp = client.chat.completions.create(
            model=PLANNER_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.controllerPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/execute-step")
def execute_step(req: ExecuteReq):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)
    recent_text = format_recent_actions(req.meta)


    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    last_error = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""
        last_error = req.meta.get("lastError") or ""


    step_text = json.dumps(req.step, ensure_ascii=False)


    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"STEP:\n{step_text}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"RECENT_ACTIONS:\n{recent_text}\n\n"
        f"ELEMENTS:\n{elements_text}\n\n"
        f"NOTES:\n{last_error}"
    )


    try:
        resp = client.chat.completions.create(
            model=EXECUTOR_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.executorPrompt},
                {"role": "user", "content": [{"type": "text", "text": user_text}]},
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/summarize")
def summarize(req: SummarizeReq):
    try:
        resp = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "text"},
            messages=[
                {"role": "system", "content": (
                    "You are a helpful, confident assistant. Answer in 2–4 sentences, natural and conversational, "
                    "as if speaking aloud. If the user asked a question, answer it directly first. "
                    "Do NOT give bullet points or numbered steps. Be concise and avoid filler or rambling."
                )},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": req.question},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        return {"answer": resp.choices[0].message.content}
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))




INTENT_SYSTEM = """
You are a router for simple browser commands. Return ONLY one JSON object: {"action": "...", "value": ...}
Allowed actions:
- show_overlays         (no value)
- hide_overlays         (no value)
- scroll                "up" | "up_small" | "down" | "down_small" | "top" | "bottom"
- click_index           integer
- switch_tab            "next" | "prev" | integer
- search                string
- open_url              string
Rules:
- JSON only. No prose. No code fences.
- Pick the single best action; no multi-step.
- “a little” → up_small/down_small; “all the way” → top/bottom.
- “tab 4” → switch_tab 4; “next tab”/“previous tab” → next/prev.
- “click/choose/select/press N” → click_index N.
- “google/search X” → search X. “open/go to <domain/url>” → open_url.
- If nothing matches, return {"action":"show_overlays","value":null}.
"""




@app.post("/intent")
def intent(req: IntentReq):
    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": INTENT_SYSTEM},
                {"role": "user", "content": req.text},
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/status")
def status(req: StatusReq):
    url = ""
    title = ""
    page_context = ""
    elements_text = ""
    history_text = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        page_context = req.meta.get("pageContext") or ""
        elements_text = format_elements(req.meta, limit=40)
        history_text = format_trimmed_history(req.meta, limit=5)

    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"ELEMENTS:\n{elements_text}"
    )

    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.statusPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        print("LLM error:", e)
        raise HTTPException(status_code=500, detail=str(e))




# -------- Realtime WebSocket relay (fixed) --------




OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]


async def _connect_openai_ws(url: str):
    # websockets has had parameter name changes across versions.
    headers = [("Authorization", f"Bearer {OPENAI_API_KEY}")]
    try:
        return await websockets.connect(url, additional_headers=headers, ping_interval=20, ping_timeout=20)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers, ping_interval=20, ping_timeout=20)








def _strict_base64_normalize(s: str) -> str:
    """
    Validates base64 and re-encodes it in a strict canonical form.
    Drops invalid chunks instead of forwarding bad data to OpenAI.
    """
    if not isinstance(s, str) or not s:
        return ""
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        return ""
    # PCM16 should be an even number of bytes; if not, trim last byte.
    if len(raw) % 2 == 1:
        raw = raw[:-1]
    return base64.b64encode(raw).decode("ascii")








def _extract_text_from_response_done(evt: dict) -> str:
    """
    response.done includes a 'response' with output items.
    We pull any output_text parts and join them.
    """
    resp = evt.get("response") or {}
    outs = resp.get("output") or []
    chunks = []
    for item in outs:
        content = item.get("content") or []
        for part in content:
            if part.get("type") == "output_text":
                t = part.get("text") or ""
                if t:
                    chunks.append(t)
    return "".join(chunks).strip()


@app.websocket("/ws/realtime")
async def realtime_proxy(ws: WebSocket):
    await ws.accept()


    try:
        openai_ws = await _connect_openai_ws(OPENAI_REALTIME_URL)
        await openai_ws.send(json.dumps({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {"model": "gpt-4o-transcribe", "language": "en"},
                "turn_detection": {
                    "type": "server_vad"
                }
            }
            }
        }
        }))




        print("[ws] connected to OpenAI Realtime")
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"failed to connect/configure OpenAI: {e}"})
        try: await ws.close()
        except Exception: pass
        return


    partial_accum = ""


    async def client_to_openai():
        try:
            async for message in ws.iter_text():
                try:
                    msg = json.loads(message)
                except Exception:
                    continue
                mtype = msg.get("type")


                if mtype == "start":
                    await openai_ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                    continue


                if mtype == "audio":
                    audio_b64 = msg.get("data", "")
                    norm = _strict_base64_normalize(audio_b64)
                    if not norm:
                        continue
                    await openai_ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": norm,
                    }))
                    continue


        except WebSocketDisconnect:
            print("[ws] client disconnected")
        except Exception as e:
            print(f"[ws] client_to_openai error: {e}")


    async def openai_to_client():
        nonlocal partial_accum
        try:
            async for message in openai_ws:
                try:
                    evt = json.loads(message)
                except Exception:
                    continue


                etype = evt.get("type", "")


                if etype == "conversation.item.input_audio_transcription.delta":
                    delta = evt.get("delta", "") or ""
                    if delta:
                        await ws.send_json({"type": "partial", "text": delta})
                    continue


                if etype == "conversation.item.input_audio_transcription.completed":
                    final_text = evt.get("transcript", "") or ""
                    await ws.send_json({"type": "final", "text": final_text})
                    continue


                if etype == "error":
                    err = evt.get("error", {}) or {}
                    try:
                        await ws.send_json({"type": "error", "message": err.get("message", "OpenAI error")})
                    except Exception:
                        pass
                    continue


        except Exception as e:
            print(f"[ws] openai_to_client error: {e}")


    t1 = asyncio.create_task(client_to_openai())
    t2 = asyncio.create_task(openai_to_client())
    done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()


    try: await openai_ws.close()
    except Exception: pass
    try: await ws.close()
    except Exception: pass
    print("[ws] closed")



