/**
 * Analog Clock — settings, fullscreen, themes
 */

const STORAGE_KEY = "analog-clock-settings";

const ROMAN = {
  12: "XII", 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI",
  7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI",
};

const ARABIC = {
  12: "12", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6",
  7: "7", 8: "8", 9: "9", 10: "10", 11: "11",
};

const COLOR_KEYS = [
  { key: "bg", label: "화면 배경", css: "--color-bg" },
  { key: "faceBorder", label: "시계 테두리", css: "--color-face-border" },
  { key: "faceBg", label: "시계 배경", css: "--color-face-bg" },
  { key: "number", label: "숫자", css: "--color-number" },
  { key: "marker", label: "눈금", css: "--color-marker" },
  { key: "markerMajor", label: "주 눈금", css: "--color-marker-major" },
  { key: "handHour", label: "시침", css: "--color-hand-hour" },
  { key: "handMinute", label: "분침", css: "--color-hand-minute" },
  { key: "handSecond", label: "초침", css: "--color-hand-second" },
  { key: "hub", label: "중심점", css: "--color-hub" },
];

const PALETTES = {
  dark: {
    bg: "#0d0d0f",
    faceBg: "#141418",
    faceBorder: "#2a2a32",
    number: "#c8c8d0",
    marker: "#4a4a55",
    markerMajor: "#9a9aa8",
    handHour: "#e8e8ec",
    handMinute: "#ffffff",
    handSecond: "#6b9fff",
    hub: "#f0f0f2",
    hubRing: "#6b9fff",
  },
  light: {
    bg: "#f2f2f7",
    faceBg: "#ffffff",
    faceBorder: "#d1d1d6",
    number: "#3a3a3c",
    marker: "#c5c5ca",
    markerMajor: "#6e6e73",
    handHour: "#1c1c1e",
    handMinute: "#000000",
    handSecond: "#007aff",
    hub: "#1c1c1e",
    hubRing: "#007aff",
  },
};

const DEFAULT_SETTINGS = {
  colorMode: "dark",
  numberSize: 1,
  clockSize: 1,
  numeral: "arabic",
  handStyle: "bar",
  faceShape: "circle",
  borderStyle: "solid",
  colors: { ...PALETTES.dark, hubRing: PALETTES.dark.hubRing },
};

function cloneDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    colors: { ...DEFAULT_SETTINGS.colors },
  };
}

class SettingsManager {
  constructor(root = document.documentElement) {
    this.root = root;
    this.settings = cloneDefaults();
    this._listeners = new Set();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.apply();
      const saved = JSON.parse(raw);
      const mode = saved.colorMode || "dark";
      const base = PALETTES[mode] || PALETTES.dark;
      this.settings = {
        ...cloneDefaults(),
        ...saved,
        colors: { ...base, ...saved.colors },
      };
    } catch {
      this.settings = cloneDefaults();
    }
    return this.apply();
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  apply() {
    const s = this.settings;
    this.root.dataset.colorMode = s.colorMode;
    this.root.dataset.handStyle = s.handStyle;
    this.root.dataset.faceShape = s.faceShape;
    this.root.dataset.borderStyle = s.borderStyle;
    this.root.dataset.numeral = s.numeral;
    this.root.style.setProperty("--number-scale", String(s.numberSize));
    this.root.style.setProperty("--clock-scale", String(s.clockSize));

    COLOR_KEYS.forEach(({ key, css }) => {
      const val = s.colors[key];
      if (val) this.root.style.setProperty(css, val);
    });
    if (s.colors.hubRing) {
      this.root.style.setProperty("--color-hub-ring", s.colors.hubRing);
    }

    this._updateNumerals();
    this._listeners.forEach((fn) => fn(this.settings));
    return this.settings;
  }

  _updateNumerals() {
    const map = this.settings.numeral === "roman" ? ROMAN : ARABIC;
    document.querySelectorAll(".clock__numbers [data-n]").forEach((el) => {
      const n = el.dataset.n;
      el.textContent = map[n] ?? n;
    });
  }

  set(partial) {
    Object.assign(this.settings, partial);
    if (partial.colors) {
      this.settings.colors = { ...this.settings.colors, ...partial.colors };
    }
    this.apply();
    this.save();
  }

  toggleColorMode() {
    const next = this.settings.colorMode === "dark" ? "light" : "dark";
    this.applyPalette(next);
  }

  applyPalette(mode) {
    const palette = PALETTES[mode];
    if (!palette) return;
    this.settings.colorMode = mode;
    this.settings.colors = { ...palette };
    this.apply();
    this._syncColorInputs();
    this.save();
  }

  resetColors() {
    this.applyPalette(this.settings.colorMode);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _syncColorInputs() {
    document.querySelectorAll("[data-color-key]").forEach((input) => {
      const val = this.settings.colors[input.dataset.colorKey];
      if (val) input.value = toHex(val);
    });
  }
}

function toHex(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const el = document.createElement("div");
  el.style.color = color;
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color;
  el.remove();
  const m = rgb.match(/\d+/g);
  if (!m) return "#000000";
  return `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

class AnalogClock {
  constructor(root) {
    this.root = root;
    this.hourHand = root.querySelector(".hand--hour");
    this.minuteHand = root.querySelector(".hand--minute");
    this.secondHand = root.querySelector(".hand--second");
    this._rafId = null;
    this._running = false;
  }

  static getAngles(date = new Date()) {
    const ms = date.getMilliseconds();
    const s = date.getSeconds() + ms / 1000;
    const m = date.getMinutes() + s / 60;
    const h = (date.getHours() % 12) + m / 60;
    return { hour: h * 30, minute: m * 6, second: s * 6 };
  }

  setHandRotation(el, degrees) {
    if (!el) return;
    el.style.transform = `rotate(${degrees}deg)`;
  }

  tick() {
    const { hour, minute, second } = AnalogClock.getAngles();
    this.setHandRotation(this.hourHand, hour);
    this.setHandRotation(this.minuteHand, minute);
    this.setHandRotation(this.secondHand, second);
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      this.tick();
      this._rafId = requestAnimationFrame(loop);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.tick();
      this._intervalId = setInterval(() => this.tick(), 1000);
    } else {
      loop();
    }
  }
}

class FullscreenController {
  constructor(btn) {
    this.btn = btn;
    document.addEventListener("fullscreenchange", () => this._sync());
    btn?.addEventListener("click", () => this.toggle());
  }

  get active() {
    return Boolean(document.fullscreenElement);
  }

  async toggle() {
    try {
      if (this.active) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* unsupported */
    }
  }

  _sync() {
    if (!this.btn) return;
    const on = this.active;
    this.btn.setAttribute("aria-label", on ? "전체화면 종료" : "전체화면");
    this.btn.setAttribute("aria-pressed", String(on));
  }
}

function buildColorInputs(container, settings) {
  container.replaceChildren();
  const allKeys = [
    ...COLOR_KEYS,
    { key: "hubRing", label: "중심 링", css: "--color-hub-ring" },
  ];

  allKeys.forEach(({ key, label }) => {
    const row = document.createElement("label");
    row.className = "settings__color-row";
    const input = document.createElement("input");
    input.type = "color";
    input.dataset.colorKey = key;
    input.value = toHex(settings.colors[key] ?? "#000000");
    input.setAttribute("aria-label", label);
    const span = document.createElement("span");
    span.textContent = label;
    row.append(input, span);
    container.appendChild(row);
  });
}

function bindSettingsUI(settingsMgr) {
  const panel = document.getElementById("settings-panel");
  const btnSettings = document.getElementById("btn-settings");
  const btnColorMode = document.getElementById("btn-color-mode");
  const slider = document.getElementById("set-number-size");
  const outSize = document.getElementById("out-number-size");
  const clockSlider = document.getElementById("set-clock-size");
  const outClockSize = document.getElementById("out-clock-size");
  const handSelect = document.getElementById("set-hand-style");
  const faceSelect = document.getElementById("set-face-shape");
  const borderSelect = document.getElementById("set-border-style");
  const colorContainer = document.getElementById("color-inputs");
  const btnResetColors = document.getElementById("btn-reset-colors");

  buildColorInputs(colorContainer, settingsMgr.settings);

  const openSettings = () => {
    panel.hidden = false;
    document.body.classList.add("settings-open");
    btnSettings?.setAttribute("aria-expanded", "true");
    settingsMgr._syncColorInputs();
  };

  const closeSettings = () => {
    panel.hidden = true;
    document.body.classList.remove("settings-open");
    btnSettings?.setAttribute("aria-expanded", "false");
  };

  btnSettings?.addEventListener("click", () => {
    if (!panel.hidden) closeSettings();
    else openSettings();
  });
  panel.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", closeSettings);
  });

  btnColorMode?.addEventListener("click", () => {
    settingsMgr.toggleColorMode();
    syncColorModeButton(btnColorMode, settingsMgr.settings.colorMode);
    settingsMgr._syncColorInputs();
  });

  slider?.addEventListener("input", () => {
    const v = Number(slider.value);
    if (outSize) outSize.textContent = `${Math.round(v * 100)}%`;
    settingsMgr.set({ numberSize: v });
  });

  clockSlider?.addEventListener("input", () => {
    const v = Number(clockSlider.value);
    if (outClockSize) outClockSize.textContent = `${Math.round(v * 100)}%`;
    settingsMgr.set({ clockSize: v });
  });

  document.querySelectorAll('input[name="numeral"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) settingsMgr.set({ numeral: radio.value });
    });
  });

  handSelect?.addEventListener("change", () => {
    settingsMgr.set({ handStyle: handSelect.value });
  });

  faceSelect?.addEventListener("change", () => {
    settingsMgr.set({ faceShape: faceSelect.value });
  });

  borderSelect?.addEventListener("change", () => {
    settingsMgr.set({ borderStyle: borderSelect.value });
  });

  colorContainer?.addEventListener("input", (e) => {
    const input = e.target;
    if (input.dataset?.colorKey) {
      settingsMgr.set({ colors: { [input.dataset.colorKey]: input.value } });
    }
  });

  btnResetColors?.addEventListener("click", () => {
    settingsMgr.resetColors();
    settingsMgr._syncColorInputs();
  });

  settingsMgr.onChange((s) => {
    if (slider && Math.abs(Number(slider.value) - s.numberSize) > 0.001) {
      slider.value = String(s.numberSize);
      if (outSize) outSize.textContent = `${Math.round(s.numberSize * 100)}%`;
    }
    if (clockSlider && Math.abs(Number(clockSlider.value) - s.clockSize) > 0.001) {
      clockSlider.value = String(s.clockSize);
      if (outClockSize) outClockSize.textContent = `${Math.round(s.clockSize * 100)}%`;
    }
    document.querySelectorAll('input[name="numeral"]').forEach((r) => {
      r.checked = r.value === s.numeral;
    });
    if (handSelect) handSelect.value = s.handStyle;
    if (faceSelect) faceSelect.value = s.faceShape;
    if (borderSelect) borderSelect.value = s.borderStyle;
    syncColorModeButton(btnColorMode, s.colorMode);
  });
}

function syncColorModeButton(btn, mode) {
  if (!btn) return;
  btn.setAttribute(
    "aria-label",
    mode === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"
  );
}

function syncUIFromSettings(settingsMgr) {
  const s = settingsMgr.settings;
  const slider = document.getElementById("set-number-size");
  const outSize = document.getElementById("out-number-size");
  const clockSlider = document.getElementById("set-clock-size");
  const outClockSize = document.getElementById("out-clock-size");
  if (slider) slider.value = String(s.numberSize);
  if (outSize) outSize.textContent = `${Math.round(s.numberSize * 100)}%`;
  if (clockSlider) clockSlider.value = String(s.clockSize ?? 1);
  if (outClockSize) outClockSize.textContent = `${Math.round((s.clockSize ?? 1) * 100)}%`;
  document.querySelectorAll('input[name="numeral"]').forEach((r) => {
    r.checked = r.value === s.numeral;
  });
  const handSelect = document.getElementById("set-hand-style");
  const faceSelect = document.getElementById("set-face-shape");
  const borderSelect = document.getElementById("set-border-style");
  if (handSelect) handSelect.value = s.handStyle;
  if (faceSelect) faceSelect.value = s.faceShape;
  if (borderSelect) borderSelect.value = s.borderStyle ?? "solid";
  syncColorModeButton(document.getElementById("btn-color-mode"), s.colorMode);
}

function bindKeyboard(fullscreen, settingsPanel) {
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    const key = e.key.toLowerCase();
    if (key === "f") {
      e.preventDefault();
      fullscreen.toggle();
    } else if (key === "l") {
      e.preventDefault();
      document.getElementById("btn-color-mode")?.click();
    } else if (key === "s" && settingsPanel.hidden) {
      e.preventDefault();
      document.getElementById("btn-settings")?.click();
    } else if (key === "escape" && !settingsPanel.hidden) {
      settingsPanel.hidden = true;
      document.body.classList.remove("settings-open");
      document.getElementById("btn-settings")?.setAttribute("aria-expanded", "false");
    }
  });
}

function init() {
  const settingsMgr = new SettingsManager();
  settingsMgr.load();
  syncUIFromSettings(settingsMgr);

  const clock = new AnalogClock(document.querySelector(".clock"));
  clock.start();

  const fullscreen = new FullscreenController(document.getElementById("btn-fullscreen"));
  const panel = document.getElementById("settings-panel");

  bindSettingsUI(settingsMgr);
  bindKeyboard(fullscreen, panel);

  window.AnalogClockApp = { settings: settingsMgr, clock, fullscreen };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
