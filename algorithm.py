// Google Docs: pick the TRUE frontmost popup frame (or top doc) + inject overlays
const tabId = chosen;

// Bring tab to front (helps focus + paint ordering)
await chrome.tabs.update(tabId, { active: true });
await new Promise((r) => setTimeout(r, 150));

// Get frames (fallback to only top frame if unavailable)
const frames = await new Promise((resolve) => {
  if (!chrome.webNavigation?.getAllFrames)
    return resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);

  chrome.webNavigation.getAllFrames({ tabId }, (fs) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn("getAllFrames error:", err.message);
      resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
      return;
    }
    resolve(fs || [{ frameId: 0, parentFrameId: -1, url: "" }]);
  });
});

const framesById = new Map(frames.map((f) => [f.frameId, f]));

// Probe each frame (robust to cross-origin/permission failures)
const settled = await Promise.allSettled(
  frames.map((f) =>
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [f.frameId] },
      args: [f.frameId],
      func: (frameId) => {
        const vw = Math.max(1, window.innerWidth || 0);
        const vh = Math.max(1, window.innerHeight || 0);

        const safeNum = (x, d = 0) => {
          const n = Number(x);
          return Number.isFinite(n) ? n : d;
        };

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        const isVisible = (el) => {
          if (!el) return false;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || safeNum(cs.opacity, 1) === 0)
            return false;
          const r = el.getBoundingClientRect();
          if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
          if (r.width < 3 || r.height < 3) return false;
          if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
          return true;
        };

        const rectAreaRatio = (r) => {
          const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          return (w * h) / (vw * vh);
        };

        const zIndexOf = (el) => {
          const zi = getComputedStyle(el).zIndex;
          const n = Number(zi);
          return Number.isFinite(n) ? n : 0; // "auto" => 0
        };

        // Active element + whether it's inside a modal
        const ae = document.activeElement || null;
        const aeTag = ae?.tagName || null;

        // Core modal candidates
        const modalCandidates = [
          ...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]'),
        ].filter(isVisible);

        // Common Google shells
        const extraPopupish = [
          ".goog-modalpopup",
          ".docs-dialog-container",
          ".docs-material-dialog",
          ".jfk-dialog",
          ".jfk-modal-dialog",
          ".docs-overlay-container",
          ".docs-dialog",
          ".modal-dialog",
        ].join(",");
        const extraCandidates = [...document.querySelectorAll(extraPopupish)].filter(isVisible);

        const allModals = [...new Set([...modalCandidates, ...extraCandidates])];

        // Confirm each modal is topmost at multiple points (within THIS document)
        const confirmModalTopHits = (el) => {
          const r = el.getBoundingClientRect();
          const pts = [
            { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 },
            { x: r.left + r.width * 0.25, y: r.top + r.height * 0.25 },
            { x: r.left + r.width * 0.75, y: r.top + r.height * 0.25 },
          ].map((p) => ({
            x: clamp(Math.floor(p.x), 0, vw - 1),
            y: clamp(Math.floor(p.y), 0, vh - 1),
          }));

          let hits = 0;
          for (const p of pts) {
            const topEl = document.elementFromPoint(p.x, p.y);
            if (topEl && (topEl === el || el.contains(topEl))) hits++;
          }
          return hits; // 0..3
        };

        const modalInfos = allModals.map((el) => {
          const r = el.getBoundingClientRect();
          const areaRatio = rectAreaRatio(r);
          const z = zIndexOf(el);
          const hitCount = confirmModalTopHits(el); // 0..3
          const strongTopmost = hitCount >= 2;
          const aeInThisModal = !!(ae && (el === ae || el.contains(ae)));
          return { z, areaRatio, hitCount, strongTopmost, aeInThisModal };
        });

        modalInfos.sort(
          (a, b) =>
            (b.strongTopmost - a.strongTopmost) ||
            (b.hitCount - a.hitCount) ||
            (b.aeInThisModal - a.aeInThisModal) ||
            (b.z - a.z) ||
            (b.areaRatio - a.areaRatio)
        );

        const bestModal = modalInfos[0] || null;

        // ===== NEW: parent-level "is this iframe actually frontmost?" check =====
        // If this frame is behind a popup in the parent, this will be low (0).
        // If this frame is the popup iframe on top, this will be high (2..3).
        let parentFrameTopHits = 0;
        let frameElRect = null;
        let parentProbeOk = false;

        try {
          if (window.top !== window && window.frameElement && window.parent?.document) {
            const fe = window.frameElement;
            const pr = fe.getBoundingClientRect();
            frameElRect = { left: pr.left, top: pr.top, right: pr.right, bottom: pr.bottom, w: pr.width, h: pr.height };

            const pts = [
              { x: (pr.left + pr.right) / 2, y: (pr.top + pr.bottom) / 2 },
              { x: pr.left + pr.width * 0.25, y: pr.top + pr.height * 0.25 },
              { x: pr.left + pr.width * 0.75, y: pr.top + pr.height * 0.25 },
            ].map((p) => ({
              x: clamp(Math.floor(p.x), 0, Math.max(0, window.parent.innerWidth - 1)),
              y: clamp(Math.floor(p.y), 0, Math.max(0, window.parent.innerHeight - 1)),
            }));

            for (const p of pts) {
              const topElInParent = window.parent.document.elementFromPoint(p.x, p.y);
              // top element in parent should be the iframe element itself (or contained by it)
              if (topElInParent && (topElInParent === fe || fe.contains(topElInParent))) {
                parentFrameTopHits++;
              }
            }
            parentProbeOk = true;
          }
        } catch (e) {
          // cross-origin parent: can't probe. leave hits at 0.
          parentProbeOk = false;
        }

        const hasFocus = document.hasFocus();

        // Debug: viewport center element tag (local doc)
        const cx = Math.floor(vw / 2);
        const cy = Math.floor(vh / 2);
        const centerTag = document.elementFromPoint(cx, cy)?.tagName || null;

        // ===== SCORING =====
        // Key idea:
        // - In Docs, "frontmost" should mean either:
        //   (A) top doc has modal topmost, OR
        //   (B) a child iframe is itself topmost in parent (parentFrameTopHits high) AND has modal evidence.
        let score = 0;

        // Focus still matters a lot (Docs focus signals are strong)
        if (hasFocus) score += 8000;

        // Parent iframe topmost check is the missing piece
        // Strongly prefer if this iframe is actually what the user sees on top.
        // (Top frame has no parent; it won't use this.)
        score += parentFrameTopHits * 6000; // 0..18000

        // Modal evidence in THIS doc
        if (bestModal) {
          score += 4000;
          score += (bestModal.hitCount || 0) * 2200; // 0..6600
          if (bestModal.strongTopmost) score += 1600;
          if (bestModal.aeInThisModal) score += 2200;
          score += Math.round(bestModal.areaRatio * 1800);
          score += Math.min(1200, Math.max(0, bestModal.z));
        }

        // If we can probe parent and we got 0 hits, this frame is likely "behind" something.
        if (parentProbeOk && window.top !== window && parentFrameTopHits === 0) {
          score -= 9000; // strong penalty: hidden/covered iframe
        }

        // Tiny nudge for top frame when everything else ties
        if (frameId === 0) score += 50;

        return {
          frameId,
          href: location.href,
          title: document.title || "",
          hasFocus,
          activeElementTag: aeTag,
          modalCount: allModals.length,
          centerTag,

          bestModal_z: bestModal?.z ?? null,
          bestModal_area: bestModal ? Number(bestModal.areaRatio.toFixed(3)) : null,
          bestModal_hitCount: bestModal?.hitCount ?? 0,
          bestModal_strongTopmost: !!bestModal?.strongTopmost,
          bestModal_aeInside: !!bestModal?.aeInThisModal,

          parentFrameTopHits,
          parentProbeOk,
          frameElRect,

          score,
        };
      },
    })
  )
);

const results = settled.flatMap((s, idx) => {
  const f = frames[idx];
  if (s.status !== "fulfilled") {
    return [
      {
        frameId: f?.frameId ?? null,
        score: -1,
        error: String(s.reason || "inject failed"),
        frameUrl: f?.url || "",
        parentFrameId: f?.parentFrameId ?? null,
      },
    ];
  }
  const r = s.value?.[0];
  const v = r?.result || {};
  const meta = framesById.get(v.frameId) || f || {};
  return [
    {
      frameId: v.frameId,
      score: v.score,
      hasFocus: v.hasFocus,
      modalCount: v.modalCount,

      hitCount: v.bestModal_hitCount,
      strongTopmost: v.bestModal_strongTopmost,
      aeInModal: v.bestModal_aeInside,
      bestZ: v.bestModal_z,
      bestArea: v.bestModal_area,

      parentProbeOk: v.parentProbeOk,
      parentFrameTopHits: v.parentFrameTopHits,

      ae: v.activeElementTag,
      centerTag: v.centerTag,
      href: v.href,
      frameUrl: meta.url || "",
      parentFrameId: meta.parentFrameId ?? null,
      title: v.title,
      error: null,
    },
  ];
});

results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
console.table(results);

// Selection:
// - Prefer frames that are actually frontmost in parent (parentFrameTopHits>=2), OR top frame with strong modal evidence.
const strong = results.filter((r) => {
  if ((r.score ?? -1) < 0) return false;

  const frontmostIframe = (r.parentProbeOk === true) && (r.parentFrameTopHits ?? 0) >= 2;
  const strongModal = (r.strongTopmost === true) || (r.hitCount ?? 0) >= 2 || (r.aeInModal === true);

  // If it’s a child frame, require frontmostIframe OR very strong modal + focus
  if ((r.parentFrameId ?? -1) !== -1 && r.frameId !== 0) {
    return frontmostIframe || (strongModal && r.hasFocus);
  }

  // Top frame: strong modal evidence is enough
  return strongModal;
});

const weak = results.filter((r) => (r.score ?? -1) >= 0 && ((r.modalCount ?? 0) > 0 || (r.hitCount ?? 0) > 0));

let best =
  strong[0] ||
  weak[0] ||
  results.find((r) => (r.score ?? -1) >= 0);

if (!best) {
  console.log("❌ No injectable frames found (missing host permissions / all blocked).");
} else {
  console.log("✅ Best popup/modal frame candidate:", best.frameId, best.href);

  // Inject overlay painter into the chosen frame
  const overlayResult = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [best.frameId] },
    args: [{ max: 180, minArea: 80, pad: 2 }],
    func: ({ max, minArea, pad }) => {
      const OVERLAY_CLASS = "__cora_overlay__";
      const LABEL_CLASS = "__cora_label__";
      const STYLE_ID = "__cora_overlay_style__";

      document.querySelectorAll(`.${OVERLAY_CLASS}, .${LABEL_CLASS}`).forEach((n) => n.remove());

      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
          .${OVERLAY_CLASS}{
            position:fixed; z-index:2147483647;
            border:2px solid #00d1ff; border-radius:8px;
            box-sizing:border-box; pointer-events:none;
            background:rgba(0,209,255,0.06);
          }
          .${LABEL_CLASS}{
            position:fixed; z-index:2147483647;
            font: 12px/1.2 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto;
            background:#00d1ff; color:#000;
            padding:2px 6px; border-radius:999px;
            box-shadow:0 2px 8px rgba(0,0,0,0.25);
            pointer-events:none;
            transform: translateY(-100%);
            white-space:nowrap;
          }
        `;
        document.documentElement.appendChild(style);
      }

      const vw = Math.max(1, innerWidth);
      const vh = Math.max(1, innerHeight);

      const isVisible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0)
          return false;
        const r = el.getBoundingClientRect();
        if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
        if (r.width < 3 || r.height < 3) return false;
        if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
        return true;
      };

      const isClickable = (el) => {
        if (!(el instanceof Element)) return false;
        const tag = el.tagName;
        if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA")
          return true;
        const role = el.getAttribute("role");
        if (role && ["button", "link", "menuitem", "option", "tab", "checkbox", "radio", "switch"].includes(role))
          return true;
        if (el.hasAttribute("onclick")) return true;
        const tb = el.getAttribute("tabindex");
        if (tb != null && Number(tb) >= 0) return true;
        return false;
      };

      const base = Array.from(
        document.querySelectorAll(`
          button, a[href], input, select, textarea,
          [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"],
          [tabindex]
        `)
      );

      let candidates = base
        .filter(isVisible)
        .filter(isClickable)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          return { el, r, area };
        })
        .filter((x) => x.area >= minArea);

      candidates.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
      candidates = candidates.slice(0, max);

      candidates.forEach((c, i) => {
        const { r } = c;

        const box = document.createElement("div");
        box.className = OVERLAY_CLASS;
        box.style.left = `${Math.max(0, r.left - pad)}px`;
        box.style.top = `${Math.max(0, r.top - pad)}px`;
        box.style.width = `${Math.min(vw, r.width + pad * 2)}px`;
        box.style.height = `${Math.min(vh, r.height + pad * 2)}px`;

        const label = document.createElement("div");
        label.className = LABEL_CLASS;
        label.textContent = String(i + 1);
        label.style.left = `${Math.max(0, r.left)}px`;
        label.style.top = `${Math.max(0, r.top)}px`;

        document.documentElement.appendChild(box);
        document.documentElement.appendChild(label);
      });

      return { ok: true, overlayCount: candidates.length, href: location.href, title: document.title || "" };
    },
  });

  console.log("🟦 Overlay inject result:", overlayResult?.[0]?.result ?? overlayResult);
}


