# Cora – Browser Agentic AI

Cora is a Chrome-based browser agent that observes web pages, reasons over the DOM + screenshots using OpenAI models, and executes actions such as clicking, typing, and scrolling.

It combines:

- A FastAPI backend (LLM controller / planner)
- A Chrome MV3 extension (UI observation + action execution)
- Screenshot-based multimodal reasoning
- Overlay indexing for deterministic element selection

---

# Architecture Overview

Cora consists of two main components:

## 1️⃣ Chrome Extension (Frontend Agent)

**Files**

- `manifest.json`
- `background.js`
- `content.js`
- `llmClient.js`
- `prompts.js`
- `onboarding.html`
- `onboarding.js`
- `onboarding.css`

**Responsibilities**

- Injects content scripts into pages  
- Detects clickable elements  
- Draws numbered overlays  
- Captures screenshots  
- Sends structured observations to backend  
- Executes validated actions returned by the model  

---

## 2️⃣ FastAPI Backend (LLM Controller)

**File**

- `server.py`

**Responsibilities**

- Receives page context + screenshot  
- Sends multimodal prompt to OpenAI  
- Returns structured action JSON  

**Supported Endpoints**

- `/agent-step` — baseline loop  
- `/execute-step`  
- `/status`  
- `/summarize`  
- `/intent`  
- `/profile-answer`  
- `/tts`  

---

# 🔄 End-to-End Agent Flow

1. User starts agent (goal provided)
2. `background.js` requests page observation
3. `content.js`:
   - Distills interactive elements
   - Shows overlays
   - Returns structured `elements[]` + `pageContext`
4. Background captures screenshot via:

   ```js
   chrome.tabs.captureVisibleTab()
   ```

5. `llmClient.js` sends:

   - goal
   - screenshot (base64)
   - elements
   - action history
   - metadata

6. Backend sends multimodal request to OpenAI
7. Model returns structured action:

   - `click_index`
   - `type_text`
   - `scroll`
   - `finish`

8. Action is validated against allowlist
9. `content.js` executes action
10. Loop continues until finish or max steps

---

# 📂 Repository Structure

```
cora/
│
├── manifest.json
├── background.js
├── content.js
├── llmClient.js
├── prompts.js
│
├── onboarding.html
├── onboarding.js
├── onboarding.css
│
└── server.py
```

---

# ⚙️ Installation & Setup

## 🔹 Backend Setup (FastAPI)

### 1️⃣ Install Python Dependencies

Create virtual environment:

```bash
python -m venv venv
```

Activate:

**macOS / Linux**

```bash
source venv/bin/activate
```

**Windows**

```bash
venv\Scripts\activate
```

Install packages:

```bash
pip install fastapi uvicorn openai websockets python-dotenv
```

---

### 2️⃣ Set OpenAI API Key

Cora requires your OpenAI key as an environment variable.

**Mac / Linux**

```bash
export OPENAI_API_KEY="your-key-here"
```

**Windows PowerShell**

```bash
$env:OPENAI_API_KEY="your-key-here"
```

⚠️ Never hardcode API keys in source code.

---

### 3️⃣ Run Backend

```bash
uvicorn server:app --reload --port 8000
```

Backend runs at:

```can s
http://localhost:8000
```

---

## 🔹 Chrome Extension Setup

1. Open Chrome
2. Navigate to:

```
chrome://extensions
```

3. Enable **Developer Mode**
4. Click **Load unpacked**
5. Select the project folder (where `manifest.json` lives)

The extension is now active.

---

# ▶️ Running the Agent

- Ensure backend is running on `localhost:8000`
- Open any webpage
- Start agent via:
  - Extension UI
  - Onboarding interface
  - Custom trigger in your code

Agent will:

- Index elements
- Show overlays
- Begin iterative reasoning loop

---

# 🔐 Privacy & Security Notes

Cora uses powerful browser permissions.

## Permissions Used

- `<all_urls>`
- `activeTab`
- `tabs`
- `scripting`
- `webNavigation`
- `storage`

---

## Screenshot Capture

Cora captures the **visible viewport** when making LLM decisions.

Captured data includes:

- Visible screenshot (PNG)
- URL
- Page title
- Indexed elements (text + metadata)
- Action history

Data flow:

```
Browser → Localhost Backend → OpenAI API
```

---

## API Keys

- Loaded from `OPENAI_API_KEY`
- Never committed to repository
- Never stored in Chrome extension

---

# 🚀 Future Improvements

- Observation caching
- Delta-based DOM diffing
- Plan caching
- Persistent memory layer
- Element ranking (top-K distilled elements)
- Local embedding store

---
