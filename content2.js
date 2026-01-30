// =====================================================
// CORA UI — DRAGGABLE MIC + EQUALIZER PILL
// Default aura: GREEN
// Press "C": toggle ORANGE aura + orange/red screen outline
// Press "E": toggle EXPANDED MODE (only when orange) w/ room for text
// - E again collapses back
// Hold Space: speaking animation + shows "Listening" (debug)
// Exposes: window.CoraListenUI.setExpanded(true/false), .setResponse(text), etc.
// =====================================================
(() => {
  const ROOT_ID = "cora-listen-ui-root";
  const STYLE_ID = "cora-listen-ui-style";
  const POS_KEY  = "cora_listen_ui_pos_v1";

  const OUTLINE_ID = "cora-orange-screen-outline";
  const OUTLINE_STYLE_ID = "cora-orange-screen-outline-style";

  // ---------- Screen outline (only when orange) ----------
  function ensureOutlineStyles() {
    if (document.getElementById(OUTLINE_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = OUTLINE_STYLE_ID;
    style.textContent = `
      #${OUTLINE_ID}{
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483646; /* under UI */
        /* warm inner bleed */
        background: radial-gradient(
          80% 80% at 50% 50%,
          rgba(0,0,0,0) 55%,
          rgba(255,210,90,0.16) 78%,
          rgba(255,140,40,0.12) 92%,
          rgba(255,70,70,0.10) 100%
        );
        box-shadow:
          inset 0 0 0 1px rgba(255,210,90,0.18),
          inset 0 0 28px rgba(255,210,90,0.20),
          inset 0 0 80px rgba(255,140,40,0.16),
          inset 0 0 140px rgba(255,70,70,0.12);
      }

      /* gradient ring (no seam) */
      #${OUTLINE_ID}::before{
        content:"";
        position:absolute;
        inset:0;
        padding: 4px;
        background: linear-gradient(
          90deg,
          rgba(255,210,90,0.95),
          rgba(255,140,40,0.95),
          rgba(255,70,70,0.95),
          rgba(255,140,40,0.95),
          rgba(255,210,90,0.95)
        );
        -webkit-mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        filter: blur(0.45px);
        opacity: 0.95;
        box-shadow:
          0 0 14px rgba(255,140,40,0.22),
          0 0 32px rgba(255,70,70,0.14);
        pointer-events:none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showOrangeOutline() {
    ensureOutlineStyles();
    if (document.getElementById(OUTLINE_ID)) return;
    const el = document.createElement("div");
    el.id = OUTLINE_ID;
    document.documentElement.appendChild(el);
  }

  function hideOrangeOutline() {
    document.getElementById(OUTLINE_ID)?.remove();
  }

  // ---------- UI styles ----------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 2147483647;
        pointer-events: auto; /* draggable */
        user-select: none;
      }

      .cora-ui{
        pointer-events: auto;
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 999px;

        background: rgba(15,15,18,0.82);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);

        box-shadow:
          0 10px 35px rgba(0,0,0,0.45),
          0 0 0 1px rgba(255,255,255,0.10) inset;

        color: #fff;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        overflow: hidden;
        cursor: grab;

        transition:
          box-shadow 180ms ease,
          padding 160ms ease,
          gap 160ms ease,
          width 180ms ease,
          max-width 180ms ease;
      }
      .cora-ui:active{ cursor: grabbing; }

      /* halo */
      .cora-ui::before{
        content: "";
        position: absolute;
        inset: -16px;
        border-radius: 999px;
        pointer-events: none;
        opacity: 1;
        filter: blur(6px);
        transition: background 180ms ease;
        background: radial-gradient(
          60% 70% at 50% 50%,
          rgba(60, 255, 170, 0.40) 0%,
          rgba(30, 210, 120, 0.20) 45%,
          rgba(30, 210, 120, 0.00) 75%
        );
      }

      .cora-mic{
        width: 28px;
        height: 28px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: rgba(255,255,255,0.10);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.10) inset;
        flex: 0 0 auto;
        transition: background 180ms ease, box-shadow 180ms ease;
      }

      .cora-bars{
        display: inline-flex;
        align-items: flex-end;
        gap: 4px;
        flex: 0 0 auto;
      }
      .cora-bar{
        width: 4px;
        height: 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.88);
        opacity: 0.9;
        transition: height 140ms ease, opacity 140ms ease;
      }

      /* Debug text (only while speaking, in compact mode) */
      .cora-text{
        font-size: 13px;
        letter-spacing: 0.2px;
        white-space: nowrap;
        max-width: 0;
        opacity: 0;
        overflow: hidden;
        margin-left: 0;
        transition: max-width 180ms ease, opacity 160ms ease, margin-left 160ms ease;
      }

      /* Expanded response layout: avatar + typing text */
      .cora-response{
        display: none;
        flex: 1 1 auto;
        min-width: 0;
        color: rgba(255,255,255,0.92);
        font-size: 13px;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
      }

      .cora-avatar{
        width: 36px;
        height: 36px;
        flex: 0 0 auto;

        border-radius: 0;          /* keep it non-circle */
        object-fit: contain;
        object-position: center;

        background: transparent;    /* <-- remove the square */
        box-shadow: none;           /* <-- remove the border */
        display: block;
      }


      .cora-bubble{
        flex: 1 1 auto;
        min-width: 0;
        padding-top: 2px;
      }

      .cora-typing{
        display: inline;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .cora-caret{
        display: inline-block;
        width: 8px;
        height: 1em;
        margin-left: 2px;
        border-left: 2px solid rgba(255,255,255,0.85);
        transform: translateY(2px);
        animation: coraCaretBlink 1s steps(1) infinite;
      }

      @keyframes coraCaretBlink{
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }




      /* Speaking animation */
      #${ROOT_ID}.cora-speaking .cora-bar{
        animation: coraBounce 650ms ease-in-out infinite;
        opacity: 1;
      }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(1){ animation-delay: 0ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(2){ animation-delay: 70ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(3){ animation-delay: 140ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(4){ animation-delay: 210ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(5){ animation-delay: 280ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(6){ animation-delay: 350ms; }
      #${ROOT_ID}.cora-speaking .cora-bar:nth-child(7){ animation-delay: 420ms; }

      @keyframes coraBounce{
        0%   { height: 6px;  }
        35%  { height: 18px; }
        70%  { height: 9px;  }
        100% { height: 6px;  }
      }

      /* Compact speaking: show "Listening" */
      #${ROOT_ID}.cora-speaking:not(.cora-expanded) .cora-text{
        max-width: 120px;
        opacity: 0.95;
        margin-left: 2px;
      }

      /* GREEN default */
      #${ROOT_ID}.cora-green .cora-ui{
        box-shadow:
          0 10px 35px rgba(0,0,0,0.45),
          0 0 0 1px rgba(60, 255, 170, 0.16) inset,
          0 0 22px rgba(60, 255, 170, 0.14);
      }
      #${ROOT_ID}.cora-green .cora-mic{
        background: rgba(60, 255, 170, 0.14);
        box-shadow:
          0 0 0 1px rgba(60, 255, 170, 0.18) inset,
          0 0 14px rgba(60, 255, 170, 0.10);
      }

      /* ORANGE mode */
      #${ROOT_ID}.cora-orange .cora-ui{
        box-shadow:
          0 10px 35px rgba(0,0,0,0.45),
          0 0 0 1px rgba(255, 170, 70, 0.18) inset,
          0 0 24px rgba(255, 140, 40, 0.22);
      }
      #${ROOT_ID}.cora-orange .cora-mic{
        background: rgba(255, 160, 60, 0.16);
        box-shadow:
          0 0 0 1px rgba(255, 170, 70, 0.22) inset,
          0 0 16px rgba(255, 140, 40, 0.16);
      }
      #${ROOT_ID}.cora-orange .cora-ui::before{
        background: radial-gradient(
          60% 70% at 50% 50%,
          rgba(255, 155, 55, 0.45) 0%,
          rgba(255, 70, 70, 0.18) 45%,
          rgba(255, 120, 30, 0.00) 75%
        );
      }

      /* EXPANDED MODE (only when orange, toggled by E) */
      /* ~2x width and ~3x height vs the compact pill */
      #${ROOT_ID}.cora-expanded .cora-ui{
        width: min(260px, calc(100vw - 60px));  /* ~2x wider */
        max-width: 260px; /* FIXED (was 240px) */

        min-height: 150px;                       /* ~3x taller */
        padding: 16px 18px;
        border-radius: 18px;

        /* text-only box */
        gap: 0;
        align-items: stretch;
        cursor: grab;
      }

      /* Hide everything except the response text */
      #${ROOT_ID}.cora-expanded .cora-mic{ display: none; }
      #${ROOT_ID}.cora-expanded .cora-bars{ display: none; }
      #${ROOT_ID}.cora-expanded .cora-text{ display: none; }

      #${ROOT_ID}.cora-expanded .cora-response{
        display: flex;
        gap: 12px;
        align-items: flex-start;
        flex: 1 1 auto;
        width: 100%;
        max-height: 100%;
        overflow: auto;
      }

      .cora-hidden{ display:none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureUI() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;

    root.innerHTML = `
      <div class="cora-ui" role="status" aria-live="polite">
        <div class="cora-mic" aria-hidden="true" title="Cora">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <path d="M19 11a7 7 0 0 1-14 0" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 18v3" stroke="white" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>

        <div class="cora-bars" aria-hidden="true">
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
          <div class="cora-bar"></div>
        </div>

        <div class="cora-text">Listening</div>


        <div class="cora-response" id="cora-response" aria-live="polite">
          <img class="cora-avatar" id="cora-avatar" alt="Cora"/>
          <div class="cora-bubble">
            <div class="cora-typing" id="cora-typing">Ready.</div><span class="cora-caret" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    // Set avatar image (adjust path if your file is in a folder)
    const avatar = root.querySelector("#cora-avatar");
    if (avatar) {
      avatar.src =
        (typeof chrome !== "undefined" && chrome.runtime?.getURL)
          ? chrome.runtime.getURL("cora_logo.png")
          : "cora_logo.png";
    }


    root.classList.add("cora-green");
    hideOrangeOutline();

    // restore saved position
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
        setPosition(saved.x, saved.y, { save: false });
      }
    } catch {}

    makeDraggable(root, root.querySelector(".cora-ui"));
    return root;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function setPosition(x, y, opts = { save: true }) {
    ensureStyle();
    const root = ensureUI();

    root.style.transform = "none";
    const rect = root.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    const cx = clamp(x, 0, maxX);
    const cy = clamp(y, 0, maxY);

    root.style.left = `${cx}px`;
    root.style.top = `${cy}px`;

    if (opts.save) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: cx, y: cy })); } catch {}
    }
  }

  // NEW: only nudge up/left if expansion causes overflow
  function ensureOnScreenAfterResize() {
    const root = ensureUI();

    root.style.transform = "none";
    const rect = root.getBoundingClientRect();

    let x = rect.left;
    let y = rect.top;

    const pad = 8;
    const overflowRight  = rect.right  - (window.innerWidth  - pad);
    const overflowBottom = rect.bottom - (window.innerHeight - pad);

    if (overflowRight > 0) x -= overflowRight;
    if (overflowBottom > 0) y -= overflowBottom; // move up only if needed

    x = clamp(x, pad, window.innerWidth  - rect.width  - pad);
    y = clamp(y, pad, window.innerHeight - rect.height - pad);

    setPosition(x, y, { save: true });
  }

  // Keep nudging while the CSS transition is still changing size
  function ensureOnScreenFor(ms = 220) {
    const start = performance.now();

    const tick = () => {
      ensureOnScreenAfterResize();
      if (performance.now() - start < ms) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    // final safety nudge after transition settles
    setTimeout(() => ensureOnScreenAfterResize(), ms + 30);
  }


  function makeDraggable(root, handle) {
    let dragging = false;
    let startX = 0, startY = 0;
    let baseX = 0, baseY = 0;

    const getXY = (e) => {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    };

    const onDown = (e) => {
      if (e.type === "mousedown" && e.button !== 0) return;
      dragging = true;

      const rect = root.getBoundingClientRect();
      baseX = rect.left;
      baseY = rect.top;

      const p = getXY(e);
      startX = p.x;
      startY = p.y;

      root.style.transform = "none";
      root.style.left = `${baseX}px`;
      root.style.top = `${baseY}px`;

      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const p = getXY(e);
      setPosition(baseX + (p.x - startX), baseY + (p.y - startY), { save: true });
      e.preventDefault();
    };

    const onUp = () => { dragging = false; };

    handle.addEventListener("mousedown", onDown, { passive: false });
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp, { passive: true });

    handle.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp, { passive: true });
  }

  function shouldIgnoreHotkeyTarget(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function isOrangeActive() {
    const root = ensureUI();
    return root.classList.contains("cora-orange");
  }

  function setSpeaking(isSpeaking) {
    const root = ensureUI();
    root.classList.toggle("cora-speaking", !!isSpeaking);
  }

  // mode: "green" | "orange"
  function setAura(mode) {
    const root = ensureUI();
    root.classList.remove("cora-green", "cora-orange");
    root.classList.add(mode === "orange" ? "cora-orange" : "cora-green");

    if (mode === "orange") showOrangeOutline();
    else {
      hideOrangeOutline();
      // if we leave orange mode, collapse expanded automatically
      root.classList.remove("cora-expanded");
    }
  }

  function toggleAura() {
    setAura(isOrangeActive() ? "green" : "orange");
  }

  function setExpanded(expanded) {
  const root = ensureUI();
  if (!isOrangeActive()) return;
  root.classList.toggle("cora-expanded", !!expanded);
  ensureOnScreenFor(240); // slightly > your 180ms CSS transition
  }

  function toggleExpanded() {
  const root = ensureUI();
  if (!isOrangeActive()) return;
  root.classList.toggle("cora-expanded");
  ensureOnScreenFor(240);
  }

  let typingSeq = 0;

  function setResponse(text, { speed = 16 } = {}) {
    const root = ensureUI();
    const typingEl = root.querySelector("#cora-typing");
    if (!typingEl) return;

    const seq = ++typingSeq;
    const full = String(text ?? "");

    typingEl.textContent = "";
    let i = 0;

    const tick = () => {
      if (seq !== typingSeq) return; // cancel previous typing
      typingEl.textContent = full.slice(0, i);
      i++;
      if (i <= full.length) setTimeout(tick, speed);
    };

    tick();
  }


  // Init
  ensureStyle();
  ensureUI();
  setAura("green");
  setSpeaking(false);

  // Debug keys:
  // Space hold => speaking
  // C => toggle orange + outline
  // E => toggle expanded (only when orange)
  let spaceDown = false;

  window.addEventListener("keydown", (e) => {
    if (shouldIgnoreHotkeyTarget(e.target)) return;

    if (e.code === "Space") {
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        setSpeaking(true);
      }
    }

    if (e.code === "KeyC") {
      e.preventDefault();
      toggleAura();
    }

    if (e.code === "KeyE") {
      e.preventDefault();
      toggleExpanded();
    }
  }, { capture: true });

  window.addEventListener("keyup", (e) => {
    if (shouldIgnoreHotkeyTarget(e.target)) return;

    if (e.code === "Space") {
      e.preventDefault();
      spaceDown = false;
      setSpeaking(false);
    }
  }, { capture: true });

  // Console hooks
  window.CoraListenUI = {
    setAura,
    toggleAura,
    setSpeaking,
    setExpanded,
    toggleExpanded,
    setResponse,
    setPosition,
    outlineOn: showOrangeOutline,
    outlineOff: hideOrangeOutline,
  };
})();
