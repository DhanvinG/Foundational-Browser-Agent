(() => {
  const steps = Array.from(document.querySelectorAll(".step"));
  const dots = Array.from(document.querySelectorAll(".step-dot"));
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");
  const finishBtn = document.getElementById("finishBtn");
  const statusEl = document.getElementById("status");
  const heroContinue = document.getElementById("heroContinue");

  let currentStep = 0;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function showStep(index) {
    currentStep = Math.max(0, Math.min(index, steps.length - 1));
    document.body.dataset.step = String(currentStep);
    steps.forEach((step, idx) => {
      step.classList.toggle("is-active", idx === currentStep);
    });
    dots.forEach((dot, idx) => {
      dot.classList.toggle("is-active", idx === currentStep);
    });
    backBtn.disabled = currentStep === 0;
    nextBtn.hidden = currentStep === steps.length - 1;
    finishBtn.hidden = currentStep !== steps.length - 1;
    setStatus("");
  }

  function value(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = typeof val === "string" ? val : "";
  }

  function hydrateProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    setValue("name", profile.name || "");
    setValue("email", profile.email || "");
    setValue("phone", profile.phone || "");
    setValue("role", profile.role || "");
    setValue("company", profile.company || "");
    setValue("school", profile.school || "");
    if (Array.isArray(profile.skills)) {
      setValue("skills", profile.skills.join(", "));
    } else {
      setValue("skills", profile.skills || "");
    }
    setValue("bio", profile.bio || "");
  }

  function collectProfile() {
    return {
      name: value("name"),
      email: value("email"),
      phone: value("phone"),
      role: value("role"),
      company: value("company"),
      school: value("school"),
      skills: value("skills"),
      bio: value("bio")
    };
  }

  backBtn.addEventListener("click", () => showStep(currentStep - 1));
  nextBtn.addEventListener("click", () => showStep(currentStep + 1));
  if (heroContinue) {
    heroContinue.addEventListener("click", () => showStep(1));
  }

  finishBtn.addEventListener("click", () => {
    const profile = collectProfile();
    console.log("[onboarding] Submitting profile:", profile);
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      setStatus("Could not save profile. Extension runtime unavailable.");
      return;
    }
    finishBtn.disabled = true;
    setStatus("Saving profile...");
    chrome.runtime.sendMessage({ type: "SET_USER_PROFILE", profile }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err || !resp || resp.success === false) {
        setStatus("Failed to save profile. Please try again.");
        finishBtn.disabled = false;
        return;
      }
      console.log("[onboarding] Profile saved.");
      setStatus("Profile saved. You can close this tab.");
      setTimeout(() => window.close(), 500);
    });
  });

  if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: "GET_USER_PROFILE" }, (resp) => {
      if (resp && resp.profile) hydrateProfile(resp.profile);
    });
  }

  showStep(0);
})();
