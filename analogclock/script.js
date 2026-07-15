const STORAGE_KEY = "analog-clock-settings";
const IMAGE_DB_NAME = "analog-clock-images";
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = "images";
const IMAGE_KEYS = ["bg", "faceBg"];
const IMAGE_CSS = {
  bg: { varName: "--bg-image", flag: "bgImage" },
  faceBg: { varName: "--face-bg-image", flag: "faceBgImage" },
};

/* ==========================================================================
   Background images — IndexedDB (local only, no server)
   ========================================================================== */

function openImageDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        db.createObjectStore(IMAGE_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, "readonly");
    const req = tx.objectStore(IMAGE_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, "readwrite");
    tx.objectStore(IMAGE_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE_NAME, "readwrite");
    tx.objectStore(IMAGE_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function optimizeImageBlob(blob) {
  if (!blob || !blob.type || !blob.type.startsWith("image/")) {
    throw new Error("not-image");
  }
  if (blob.type === "image/svg+xml" || blob.size < 350_000) return blob;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }
  const max = 2048;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const optimized = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
  });
  return optimized || blob;
}

const IMAGE_LS_PREFIX = "analog-clock-image:";

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function persistImageRecord(key, record) {
  try {
    await idbSet(key, record);
    try {
      localStorage.removeItem(IMAGE_LS_PREFIX + key);
    } catch {
      /* ignore */
    }
    return;
  } catch {
    /* IndexedDB unavailable (e.g. some file:// contexts) */
  }
  try {
    const dataUrl = await blobToDataURL(record.blob);
    if (dataUrl.length < 4_500_000) {
      localStorage.setItem(
        IMAGE_LS_PREFIX + key,
        JSON.stringify({ dataUrl, name: record.name || "", type: record.type || "" })
      );
    }
  } catch {
    /* persistence failed — in-memory URL still works this session */
  }
}

async function loadImageRecord(key) {
  try {
    const record = await idbGet(key);
    if (record?.blob instanceof Blob) return record;
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(IMAGE_LS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.dataUrl) return null;
    const blob = await dataURLToBlob(parsed.dataUrl);
    return { blob, name: parsed.name || "", type: parsed.type || blob.type };
  } catch {
    return null;
  }
}

async function removeImageRecord(key) {
  try {
    await idbDelete(key);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(IMAGE_LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

class BackgroundImageStore {
  constructor(root = document.documentElement) {
    this.root = root;
    this.urls = { bg: null, faceBg: null };
    this.activeKey = "bg";
  }

  async hydrate() {
    await Promise.all(IMAGE_KEYS.map((key) => this._loadKey(key)));
    this.apply();
  }

  async _loadKey(key) {
    const record = await loadImageRecord(key);
    this._revoke(key);
    if (record?.blob instanceof Blob) {
      this.urls[key] = URL.createObjectURL(record.blob);
    } else {
      this.urls[key] = null;
    }
  }

  _detachPreviews(key) {
    document.querySelectorAll(`.bg-image[data-image-key="${key}"] .bg-image__preview`).forEach((img) => {
      img.removeAttribute("src");
      img.hidden = true;
    });
  }

  _revoke(key) {
    // Revoking while <img> still points at the blob URL shows a broken-image icon.
    this._detachPreviews(key);
    if (this.urls[key]) {
      URL.revokeObjectURL(this.urls[key]);
      this.urls[key] = null;
    }
  }

  has(key) {
    return Boolean(this.urls[key]);
  }

  apply() {
    IMAGE_KEYS.forEach((key) => {
      const { varName, flag } = IMAGE_CSS[key];
      const url = this.urls[key];
      if (url) {
        this.root.style.setProperty(varName, `url("${url}")`);
        this.root.dataset[flag] = "true";
      } else {
        this.root.style.removeProperty(varName);
        delete this.root.dataset[flag];
      }
    });
  }

  async setFromBlob(key, blob, name = "") {
    if (!IMAGE_KEYS.includes(key)) return;
    const optimized = await optimizeImageBlob(blob);
    const record = {
      blob: optimized,
      name: name || "",
      type: optimized.type || blob.type || "image/*",
      updatedAt: Date.now(),
    };
    await persistImageRecord(key, record);
    this._revoke(key);
    this.urls[key] = URL.createObjectURL(optimized);
    this.apply();
  }

  async clear(key) {
    if (!IMAGE_KEYS.includes(key)) return;
    await removeImageRecord(key);
    this._revoke(key);
    this.apply();
  }
}

function syncBgImageUI(store) {
  document.querySelectorAll(".bg-image[data-image-key]").forEach((card) => {
    const key = card.dataset.imageKey;
    const preview = card.querySelector(".bg-image__preview");
    const clearBtn = card.querySelector('[data-action="clear"]');
    const has = store.has(key);
    card.classList.toggle("has-image", has);
    if (preview) {
      if (has) {
        preview.hidden = false;
        preview.src = store.urls[key];
      } else {
        preview.removeAttribute("src");
        preview.hidden = true;
      }
    }
    if (clearBtn) clearBtn.hidden = !has;
  });
}

function setActiveImageKey(store, key) {
  store.activeKey = key;
  document.querySelectorAll(".bg-image[data-image-key]").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.imageKey === key);
  });
}

async function readImageFromClipboardEvent(e) {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

async function readImageFromClipboardApi() {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await item.getType(type);
    }
  } catch {
    /* permission denied or unsupported */
  }
  return null;
}

function bindBackgroundImages(store, settingsPanel) {
  const section = document.querySelector(".settings__section--bg-images");
  if (!section) return;

  const applyBlob = async (key, blob, name) => {
    if (!blob) return;
    try {
      await store.setFromBlob(key, blob, name);
      syncBgImageUI(store);
    } catch {
      /* ignore invalid files */
    }
  };

  section.querySelectorAll(".bg-image[data-image-key]").forEach((card) => {
    const key = card.dataset.imageKey;
    const drop = card.querySelector(".bg-image__drop");
    const fileInput = card.querySelector(".bg-image__file");

    card.addEventListener("focusin", () => setActiveImageKey(store, key));
    card.addEventListener("pointerdown", () => setActiveImageKey(store, key));

    drop?.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      setActiveImageKey(store, key);
      fileInput?.click();
    });

    drop?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput?.click();
      }
    });

    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) await applyBlob(key, file, file.name);
    });

    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        setActiveImageKey(store, key);
        const action = btn.dataset.action;
        if (action === "choose") {
          fileInput?.click();
        } else if (action === "clear") {
          await store.clear(key);
          syncBgImageUI(store);
        } else if (action === "paste") {
          const blob = await readImageFromClipboardApi();
          if (blob) await applyBlob(key, blob, "clipboard");
          else alert(t("bgImagePasteFail"));
        }
      });
    });

    ["dragenter", "dragover"].forEach((type) => {
      drop?.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add("is-dragover");
        setActiveImageKey(store, key);
      });
    });
    drop?.addEventListener("dragleave", () => drop.classList.remove("is-dragover"));
    drop?.addEventListener("drop", async (e) => {
      e.preventDefault();
      drop.classList.remove("is-dragover");
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
      if (file) await applyBlob(key, file, file.name);
    });
  });

  window.addEventListener("paste", async (e) => {
    if (settingsPanel?.hidden) return;
    if (e.target?.closest?.("input, textarea, select")) return;
    const file = await readImageFromClipboardEvent(e);
    if (!file) return;
    e.preventDefault();
    await applyBlob(store.activeKey || "bg", file, "clipboard");
  });
}

/**
 * Analog Clock — settings, fullscreen, themes
 */

/* ==========================================================================
   Internationalization (i18n)
   ========================================================================== */

const I18N = {
  en: {
    toolbarAria: "Tools", fullscreen: "Fullscreen", fullscreenTitle: "Fullscreen (F)",
    toLight: "Switch to light mode", toDark: "Switch to dark mode", themeTitle: "Dark / Light (L)",
    settings: "Settings", settingsTitle: "Settings (S)", panelTitle: "Settings", close: "Close",
    clockAria: "Analog clock", language: "Language",
    theme: "Theme", themeClassic: "Classic", themeMidnight: "Midnight", themeDaylight: "Daylight", themeOcean: "Ocean Blue",
    themeBurgundy: "Burgundy", themeForest: "Forest", themeSunset: "Sunset", themeAmethyst: "Amethyst",
    themePaper: "Paper", themeRose: "Rose",
    numbers: "Numbers", size: "Size", resetSize: "Reset", arabic: "Arabic", roman: "Roman",
    clock: "Clock",
    handStyle: "Hand style", handBar: "Bar", handArrow: "Arrow", handSquare: "Square", handRounded: "Rounded",
    secondMotion: "Second hand", secondSmooth: "Smooth", secondTick: "Tick (per second)",
    tickSound: "Tick sound", tickSound1: "Sound 1", tickSound2: "Sound 2", tickSound3: "Sound 3",
    tickSound4: "Sound 4", tickSound5: "Sound 5", tickSound6: "Sound 6",
    faceShape: "Clock shape", faceCircle: "Circle", faceSquare: "Square", faceRounded: "Rounded square",
    faceRectPortrait: "Rectangle (portrait)", faceRectLandscape: "Rectangle (landscape)",
    faceOvalPortrait: "Oval (portrait)", faceOvalLandscape: "Oval (landscape)", faceStadium: "Stadium",
    faceArch: "Arch", faceHexagon: "Hexagon", faceOctagon: "Octagon", faceDiamond: "Diamond",
    faceTrapezoid: "Trapezoid", faceShield: "Shield",
    borderStyle: "Border style", borderSolid: "Solid", borderThin: "Thin", borderDouble: "Double",
    borderDashed: "Dashed", borderDotted: "Dotted", borderRing: "Ring", borderGlow: "Glow",
    borderRaised: "Raised", borderClassic: "Classic",
    colors: "Colors", resetColors: "Reset colors",
    bgImages: "Background images",
    bgImagesHint: "Choose a local file, drag & drop, or paste (Ctrl+V). Images stay on this device.",
    bgImageChoose: "Choose image", bgImagePaste: "Paste", bgImageClear: "Clear",
    bgImageDrop: "Click, drop, or paste", bgImagePasteFail: "No image in clipboard",
    share: "Share", copyUrl: "Copy settings URL", copied: "Copied!",
    colorBg: "Background", colorFaceBorder: "Clock border", colorFaceBg: "Clock face", colorNumber: "Numbers",
    colorMarker: "Ticks", colorMarkerMajor: "Major ticks", colorHandHour: "Hour hand",
    colorHandMinute: "Minute hand", colorHandSecond: "Second hand", colorHub: "Center", colorHubRing: "Center ring",
  },
  ko: {
    toolbarAria: "도구", fullscreen: "전체화면", fullscreenTitle: "전체화면 (F)",
    toLight: "라이트 모드로 전환", toDark: "다크 모드로 전환", themeTitle: "다크 / 라이트 (L)",
    settings: "설정", settingsTitle: "설정 (S)", panelTitle: "설정", close: "닫기",
    clockAria: "아날로그 시계", language: "언어",
    theme: "테마", themeClassic: "클래식", themeMidnight: "미드나잇", themeDaylight: "데이라이트", themeOcean: "오션 블루",
    themeBurgundy: "버건디", themeForest: "포레스트", themeSunset: "선셋", themeAmethyst: "자수정",
    themePaper: "페이퍼", themeRose: "로즈",
    numbers: "숫자", size: "크기", resetSize: "초기화", arabic: "아라비아", roman: "로마",
    clock: "시계",
    handStyle: "바늘 모양", handBar: "막대형", handArrow: "화살표형", handSquare: "네모형", handRounded: "둥근형",
    secondMotion: "초침", secondSmooth: "부드럽게", secondTick: "초마다 끊어서",
    tickSound: "초침 소리", tickSound1: "사운드 1", tickSound2: "사운드 2", tickSound3: "사운드 3",
    tickSound4: "사운드 4", tickSound5: "사운드 5", tickSound6: "사운드 6",
    faceShape: "시계 모양", faceCircle: "원형", faceSquare: "정사각형", faceRounded: "둥근 사각형",
    faceRectPortrait: "직사각형 (세로)", faceRectLandscape: "직사각형 (가로)",
    faceOvalPortrait: "타원 (세로)", faceOvalLandscape: "타원 (가로)", faceStadium: "스타디움",
    faceArch: "아치", faceHexagon: "육각형", faceOctagon: "팔각형", faceDiamond: "다이아몬드",
    faceTrapezoid: "사다리꼴", faceShield: "방패",
    borderStyle: "테두리 스타일", borderSolid: "실선", borderThin: "가는 실선", borderDouble: "이중선",
    borderDashed: "파선", borderDotted: "점선", borderRing: "링", borderGlow: "글로우",
    borderRaised: "입체", borderClassic: "클래식",
    colors: "색상", resetColors: "색상 초기화",
    bgImages: "배경 이미지",
    bgImagesHint: "로컬 파일 선택, 드래그 앤 드롭, 또는 붙여넣기(Ctrl+V).",
    bgImageChoose: "이미지 선택", bgImagePaste: "붙여넣기", bgImageClear: "지우기",
    bgImageDrop: "클릭 · 드롭 · 붙여넣기", bgImagePasteFail: "클립보드에 이미지가 없습니다",
    share: "공유", copyUrl: "설정 URL 복사", copied: "복사됨!",
    colorBg: "화면 배경", colorFaceBorder: "시계 테두리", colorFaceBg: "시계 배경", colorNumber: "숫자",
    colorMarker: "눈금", colorMarkerMajor: "주 눈금", colorHandHour: "시침",
    colorHandMinute: "분침", colorHandSecond: "초침", colorHub: "중심점", colorHubRing: "중심 링",
  },
  ja: {
    toolbarAria: "ツール", fullscreen: "全画面", fullscreenTitle: "全画面 (F)",
    toLight: "ライトモードに切替", toDark: "ダークモードに切替", themeTitle: "ダーク / ライト (L)",
    settings: "設定", settingsTitle: "設定 (S)", panelTitle: "設定", close: "閉じる",
    clockAria: "アナログ時計", language: "言語",
    theme: "テーマ", themeClassic: "クラシック", themeMidnight: "ミッドナイト", themeDaylight: "デイライト", themeOcean: "オーシャンブルー",
    themeBurgundy: "バーガンディ", themeForest: "フォレスト", themeSunset: "サンセット", themeAmethyst: "アメジスト",
    themePaper: "ペーパー", themeRose: "ローズ",
    numbers: "数字", size: "サイズ", resetSize: "リセット", arabic: "アラビア数字", roman: "ローマ数字",
    clock: "時計",
    handStyle: "針の形", handBar: "バー", handArrow: "矢印", handSquare: "四角", handRounded: "丸み",
    secondMotion: "秒針", secondSmooth: "スムーズ", secondTick: "秒ごとに刻む",
    tickSound: "秒針音", tickSound1: "サウンド 1", tickSound2: "サウンド 2", tickSound3: "サウンド 3",
    tickSound4: "サウンド 4", tickSound5: "サウンド 5", tickSound6: "サウンド 6",
    faceShape: "文字盤の形", faceCircle: "円形", faceSquare: "正方形", faceRounded: "角丸四角",
    faceRectPortrait: "長方形（縦）", faceRectLandscape: "長方形（横）",
    faceOvalPortrait: "楕円（縦）", faceOvalLandscape: "楕円（横）", faceStadium: "スタジアム",
    faceArch: "アーチ", faceHexagon: "六角形", faceOctagon: "八角形", faceDiamond: "ダイヤモンド",
    faceTrapezoid: "台形", faceShield: "シールド",
    borderStyle: "枠線スタイル", borderSolid: "実線", borderThin: "細線", borderDouble: "二重線",
    borderDashed: "破線", borderDotted: "点線", borderRing: "リング", borderGlow: "グロー",
    borderRaised: "立体", borderClassic: "クラシック",
    colors: "色", resetColors: "色をリセット",
    bgImages: "背景画像",
    bgImagesHint: "ローカルファイルの選択、ドラッグ＆ドロップ、または貼り付け（Ctrl+V）。画像はこの端末にのみ保存されます。",
    bgImageChoose: "画像を選択", bgImagePaste: "貼り付け", bgImageClear: "クリア",
    bgImageDrop: "クリック・ドロップ・貼付", bgImagePasteFail: "クリップボードに画像がありません",
    share: "共有", copyUrl: "設定URLをコピー", copied: "コピーしました！",
    colorBg: "背景", colorFaceBorder: "時計の枠", colorFaceBg: "文字盤", colorNumber: "数字",
    colorMarker: "目盛り", colorMarkerMajor: "主目盛り", colorHandHour: "時針",
    colorHandMinute: "分針", colorHandSecond: "秒針", colorHub: "中心", colorHubRing: "中心リング",
  },
  zh: {
    toolbarAria: "工具", fullscreen: "全屏", fullscreenTitle: "全屏 (F)",
    toLight: "切换到浅色模式", toDark: "切换到深色模式", themeTitle: "深色 / 浅色 (L)",
    settings: "设置", settingsTitle: "设置 (S)", panelTitle: "设置", close: "关闭",
    clockAria: "模拟时钟", language: "语言",
    theme: "主题", themeClassic: "经典", themeMidnight: "午夜", themeDaylight: "日光", themeOcean: "海洋蓝",
    themeBurgundy: "勃艮第红", themeForest: "森林", themeSunset: "日落", themeAmethyst: "紫水晶",
    themePaper: "纸张", themeRose: "玫瑰",
    numbers: "数字", size: "大小", resetSize: "重置", arabic: "阿拉伯数字", roman: "罗马数字",
    clock: "时钟",
    handStyle: "指针样式", handBar: "条形", handArrow: "箭头", handSquare: "方形", handRounded: "圆角",
    secondMotion: "秒针", secondSmooth: "平滑", secondTick: "每秒跳动",
    tickSound: "秒针声音", tickSound1: "声音 1", tickSound2: "声音 2", tickSound3: "声音 3",
    tickSound4: "声音 4", tickSound5: "声音 5", tickSound6: "声音 6",
    faceShape: "表盘形状", faceCircle: "圆形", faceSquare: "正方形", faceRounded: "圆角方形",
    faceRectPortrait: "矩形（竖向）", faceRectLandscape: "矩形（横向）",
    faceOvalPortrait: "椭圆（竖向）", faceOvalLandscape: "椭圆（横向）", faceStadium: "胶囊形",
    faceArch: "拱形", faceHexagon: "六边形", faceOctagon: "八边形", faceDiamond: "菱形",
    faceTrapezoid: "梯形", faceShield: "盾形",
    borderStyle: "边框样式", borderSolid: "实线", borderThin: "细线", borderDouble: "双线",
    borderDashed: "虚线", borderDotted: "点线", borderRing: "环形", borderGlow: "发光",
    borderRaised: "立体", borderClassic: "经典",
    colors: "颜色", resetColors: "重置颜色",
    bgImages: "背景图片",
    bgImagesHint: "选择本地文件、拖放，或粘贴（Ctrl+V）。图片仅保存在本设备。",
    bgImageChoose: "选择图片", bgImagePaste: "粘贴", bgImageClear: "清除",
    bgImageDrop: "点击、拖放或粘贴", bgImagePasteFail: "剪贴板中没有图片",
    share: "分享", copyUrl: "复制设置链接", copied: "已复制！",
    colorBg: "背景", colorFaceBorder: "表盘边框", colorFaceBg: "表盘", colorNumber: "数字",
    colorMarker: "刻度", colorMarkerMajor: "主刻度", colorHandHour: "时针",
    colorHandMinute: "分针", colorHandSecond: "秒针", colorHub: "中心", colorHubRing: "中心环",
  },
  es: {
    toolbarAria: "Herramientas", fullscreen: "Pantalla completa", fullscreenTitle: "Pantalla completa (F)",
    toLight: "Cambiar a modo claro", toDark: "Cambiar a modo oscuro", themeTitle: "Oscuro / Claro (L)",
    settings: "Ajustes", settingsTitle: "Ajustes (S)", panelTitle: "Ajustes", close: "Cerrar",
    clockAria: "Reloj analógico", language: "Idioma",
    theme: "Tema", themeClassic: "Clásico", themeMidnight: "Medianoche", themeDaylight: "Luz de día", themeOcean: "Azul océano",
    themeBurgundy: "Borgoña", themeForest: "Bosque", themeSunset: "Atardecer", themeAmethyst: "Amatista",
    themePaper: "Papel", themeRose: "Rosa",
    numbers: "Números", size: "Tamaño", resetSize: "Restablecer", arabic: "Arábigos", roman: "Romanos",
    clock: "Reloj",
    handStyle: "Estilo de aguja", handBar: "Barra", handArrow: "Flecha", handSquare: "Cuadrado", handRounded: "Redondeado",
    secondMotion: "Segundero", secondSmooth: "Suave", secondTick: "A saltos (por segundo)",
    tickSound: "Sonido del segundero", tickSound1: "Sonido 1", tickSound2: "Sonido 2", tickSound3: "Sonido 3",
    tickSound4: "Sonido 4", tickSound5: "Sonido 5", tickSound6: "Sonido 6",
    faceShape: "Forma del reloj", faceCircle: "Círculo", faceSquare: "Cuadrado", faceRounded: "Cuadrado redondeado",
    faceRectPortrait: "Rectángulo (vertical)", faceRectLandscape: "Rectángulo (horizontal)",
    faceOvalPortrait: "Óvalo (vertical)", faceOvalLandscape: "Óvalo (horizontal)", faceStadium: "Estadio",
    faceArch: "Arco", faceHexagon: "Hexágono", faceOctagon: "Octágono", faceDiamond: "Diamante",
    faceTrapezoid: "Trapecio", faceShield: "Escudo",
    borderStyle: "Estilo de borde", borderSolid: "Sólido", borderThin: "Fino", borderDouble: "Doble",
    borderDashed: "Discontinuo", borderDotted: "Punteado", borderRing: "Anillo", borderGlow: "Resplandor",
    borderRaised: "Relieve", borderClassic: "Clásico",
    colors: "Colores", resetColors: "Restablecer colores",
    bgImages: "Imágenes de fondo",
    bgImagesHint: "Elige un archivo local, arrastra y suelta, o pega (Ctrl+V). Las imágenes se quedan en este dispositivo.",
    bgImageChoose: "Elegir imagen", bgImagePaste: "Pegar", bgImageClear: "Quitar",
    bgImageDrop: "Clic, soltar o pegar", bgImagePasteFail: "No hay imagen en el portapapeles",
    share: "Compartir", copyUrl: "Copiar URL de ajustes", copied: "¡Copiado!",
    colorBg: "Fondo", colorFaceBorder: "Borde del reloj", colorFaceBg: "Esfera", colorNumber: "Números",
    colorMarker: "Marcas", colorMarkerMajor: "Marcas principales", colorHandHour: "Aguja de hora",
    colorHandMinute: "Aguja de minuto", colorHandSecond: "Aguja de segundo", colorHub: "Centro", colorHubRing: "Anillo central",
  },
  fr: {
    toolbarAria: "Outils", fullscreen: "Plein écran", fullscreenTitle: "Plein écran (F)",
    toLight: "Passer en mode clair", toDark: "Passer en mode sombre", themeTitle: "Sombre / Clair (L)",
    settings: "Paramètres", settingsTitle: "Paramètres (S)", panelTitle: "Paramètres", close: "Fermer",
    clockAria: "Horloge analogique", language: "Langue",
    theme: "Thème", themeClassic: "Classique", themeMidnight: "Minuit", themeDaylight: "Lumière du jour", themeOcean: "Bleu océan",
    themeBurgundy: "Bordeaux", themeForest: "Forêt", themeSunset: "Coucher de soleil", themeAmethyst: "Améthyste",
    themePaper: "Papier", themeRose: "Rose",
    numbers: "Chiffres", size: "Taille", resetSize: "Réinitialiser", arabic: "Arabes", roman: "Romains",
    clock: "Horloge",
    handStyle: "Style d'aiguille", handBar: "Barre", handArrow: "Flèche", handSquare: "Carré", handRounded: "Arrondi",
    secondMotion: "Aiguille des secondes", secondSmooth: "Fluide", secondTick: "Par à-coups (chaque seconde)",
    tickSound: "Son du trotteuse", tickSound1: "Son 1", tickSound2: "Son 2", tickSound3: "Son 3",
    tickSound4: "Son 4", tickSound5: "Son 5", tickSound6: "Son 6",
    faceShape: "Forme de l'horloge", faceCircle: "Cercle", faceSquare: "Carré", faceRounded: "Carré arrondi",
    faceRectPortrait: "Rectangle (portrait)", faceRectLandscape: "Rectangle (paysage)",
    faceOvalPortrait: "Ovale (portrait)", faceOvalLandscape: "Ovale (paysage)", faceStadium: "Stade",
    faceArch: "Arche", faceHexagon: "Hexagone", faceOctagon: "Octogone", faceDiamond: "Losange",
    faceTrapezoid: "Trapèze", faceShield: "Bouclier",
    borderStyle: "Style de bordure", borderSolid: "Plein", borderThin: "Fin", borderDouble: "Double",
    borderDashed: "Tirets", borderDotted: "Pointillés", borderRing: "Anneau", borderGlow: "Lueur",
    borderRaised: "Relief", borderClassic: "Classique",
    colors: "Couleurs", resetColors: "Réinitialiser les couleurs",
    bgImages: "Images d'arrière-plan",
    bgImagesHint: "Choisissez un fichier local, glissez-déposez, ou collez (Ctrl+V). Les images restent sur cet appareil.",
    bgImageChoose: "Choisir une image", bgImagePaste: "Coller", bgImageClear: "Effacer",
    bgImageDrop: "Cliquer, déposer ou coller", bgImagePasteFail: "Pas d'image dans le presse-papiers",
    share: "Partager", copyUrl: "Copier l'URL des réglages", copied: "Copié !",
    colorBg: "Arrière-plan", colorFaceBorder: "Bordure de l'horloge", colorFaceBg: "Cadran", colorNumber: "Chiffres",
    colorMarker: "Graduations", colorMarkerMajor: "Graduations principales", colorHandHour: "Aiguille des heures",
    colorHandMinute: "Aiguille des minutes", colorHandSecond: "Aiguille des secondes", colorHub: "Centre", colorHubRing: "Anneau central",
  },
  de: {
    toolbarAria: "Werkzeuge", fullscreen: "Vollbild", fullscreenTitle: "Vollbild (F)",
    toLight: "Zum hellen Modus", toDark: "Zum dunklen Modus", themeTitle: "Dunkel / Hell (L)",
    settings: "Einstellungen", settingsTitle: "Einstellungen (S)", panelTitle: "Einstellungen", close: "Schließen",
    clockAria: "Analoguhr", language: "Sprache",
    theme: "Thema", themeClassic: "Klassisch", themeMidnight: "Mitternacht", themeDaylight: "Tageslicht", themeOcean: "Ozeanblau",
    themeBurgundy: "Bordeaux", themeForest: "Wald", themeSunset: "Sonnenuntergang", themeAmethyst: "Amethyst",
    themePaper: "Papier", themeRose: "Rosé",
    numbers: "Zahlen", size: "Größe", resetSize: "Zurücksetzen", arabic: "Arabisch", roman: "Römisch",
    clock: "Uhr",
    handStyle: "Zeigerstil", handBar: "Balken", handArrow: "Pfeil", handSquare: "Eckig", handRounded: "Abgerundet",
    secondMotion: "Sekundenzeiger", secondSmooth: "Fließend", secondTick: "Taktend (pro Sekunde)",
    tickSound: "Sekundenton", tickSound1: "Sound 1", tickSound2: "Sound 2", tickSound3: "Sound 3",
    tickSound4: "Sound 4", tickSound5: "Sound 5", tickSound6: "Sound 6",
    faceShape: "Uhrform", faceCircle: "Kreis", faceSquare: "Quadrat", faceRounded: "Abgerundetes Quadrat",
    faceRectPortrait: "Rechteck (hoch)", faceRectLandscape: "Rechteck (quer)",
    faceOvalPortrait: "Oval (hoch)", faceOvalLandscape: "Oval (quer)", faceStadium: "Stadion",
    faceArch: "Bogen", faceHexagon: "Sechseck", faceOctagon: "Achteck", faceDiamond: "Raute",
    faceTrapezoid: "Trapez", faceShield: "Schild",
    borderStyle: "Rahmenstil", borderSolid: "Durchgezogen", borderThin: "Dünn", borderDouble: "Doppelt",
    borderDashed: "Gestrichelt", borderDotted: "Gepunktet", borderRing: "Ring", borderGlow: "Leuchten",
    borderRaised: "Erhaben", borderClassic: "Klassisch",
    colors: "Farben", resetColors: "Farben zurücksetzen",
    bgImages: "Hintergrundbilder",
    bgImagesHint: "Lokale Datei wählen, per Drag & Drop oder Einfügen (Strg+V). Bilder bleiben auf diesem Gerät.",
    bgImageChoose: "Bild wählen", bgImagePaste: "Einfügen", bgImageClear: "Entfernen",
    bgImageDrop: "Klicken, ablegen oder einfügen", bgImagePasteFail: "Kein Bild in der Zwischenablage",
    share: "Teilen", copyUrl: "Einstellungs-URL kopieren", copied: "Kopiert!",
    colorBg: "Hintergrund", colorFaceBorder: "Uhrenrand", colorFaceBg: "Zifferblatt", colorNumber: "Zahlen",
    colorMarker: "Markierungen", colorMarkerMajor: "Hauptmarkierungen", colorHandHour: "Stundenzeiger",
    colorHandMinute: "Minutenzeiger", colorHandSecond: "Sekundenzeiger", colorHub: "Mittelpunkt", colorHubRing: "Mittelring",
  },
  it: {
    toolbarAria: "Strumenti", fullscreen: "Schermo intero", fullscreenTitle: "Schermo intero (F)",
    toLight: "Passa alla modalità chiara", toDark: "Passa alla modalità scura", themeTitle: "Scuro / Chiaro (L)",
    settings: "Impostazioni", settingsTitle: "Impostazioni (S)", panelTitle: "Impostazioni", close: "Chiudi",
    clockAria: "Orologio analogico", language: "Lingua",
    theme: "Tema", themeClassic: "Classico", themeMidnight: "Mezzanotte", themeDaylight: "Luce del giorno", themeOcean: "Blu oceano",
    themeBurgundy: "Bordeaux", themeForest: "Foresta", themeSunset: "Tramonto", themeAmethyst: "Ametista",
    themePaper: "Carta", themeRose: "Rosa",
    numbers: "Numeri", size: "Dimensione", resetSize: "Reimposta", arabic: "Arabi", roman: "Romani",
    clock: "Orologio",
    handStyle: "Stile lancette", handBar: "Barra", handArrow: "Freccia", handSquare: "Quadrato", handRounded: "Arrotondato",
    secondMotion: "Lancetta dei secondi", secondSmooth: "Fluida", secondTick: "A scatti (al secondo)",
    tickSound: "Suono secondi", tickSound1: "Suono 1", tickSound2: "Suono 2", tickSound3: "Suono 3",
    tickSound4: "Suono 4", tickSound5: "Suono 5", tickSound6: "Suono 6",
    faceShape: "Forma orologio", faceCircle: "Cerchio", faceSquare: "Quadrato", faceRounded: "Quadrato arrotondato",
    faceRectPortrait: "Rettangolo (verticale)", faceRectLandscape: "Rettangolo (orizzontale)",
    faceOvalPortrait: "Ovale (verticale)", faceOvalLandscape: "Ovale (orizzontale)", faceStadium: "Stadio",
    faceArch: "Arco", faceHexagon: "Esagono", faceOctagon: "Ottagono", faceDiamond: "Diamante",
    faceTrapezoid: "Trapezio", faceShield: "Scudo",
    borderStyle: "Stile bordo", borderSolid: "Continuo", borderThin: "Sottile", borderDouble: "Doppio",
    borderDashed: "Tratteggiato", borderDotted: "Punteggiato", borderRing: "Anello", borderGlow: "Bagliore",
    borderRaised: "Rilievo", borderClassic: "Classico",
    colors: "Colori", resetColors: "Reimposta colori",
    bgImages: "Immagini di sfondo",
    bgImagesHint: "Scegli un file locale, trascina, o incolla (Ctrl+V). Le immagini restano su questo dispositivo.",
    bgImageChoose: "Scegli immagine", bgImagePaste: "Incolla", bgImageClear: "Rimuovi",
    bgImageDrop: "Clic, rilascia o incolla", bgImagePasteFail: "Nessuna immagine negli appunti",
    share: "Condividi", copyUrl: "Copia URL impostazioni", copied: "Copiato!",
    colorBg: "Sfondo", colorFaceBorder: "Bordo orologio", colorFaceBg: "Quadrante", colorNumber: "Numeri",
    colorMarker: "Tacche", colorMarkerMajor: "Tacche principali", colorHandHour: "Lancetta ore",
    colorHandMinute: "Lancetta minuti", colorHandSecond: "Lancetta secondi", colorHub: "Centro", colorHubRing: "Anello centrale",
  },
  pt: {
    toolbarAria: "Ferramentas", fullscreen: "Tela cheia", fullscreenTitle: "Tela cheia (F)",
    toLight: "Mudar para modo claro", toDark: "Mudar para modo escuro", themeTitle: "Escuro / Claro (L)",
    settings: "Configurações", settingsTitle: "Configurações (S)", panelTitle: "Configurações", close: "Fechar",
    clockAria: "Relógio analógico", language: "Idioma",
    theme: "Tema", themeClassic: "Clássico", themeMidnight: "Meia-noite", themeDaylight: "Luz do dia", themeOcean: "Azul oceano",
    themeBurgundy: "Borgonha", themeForest: "Floresta", themeSunset: "Pôr do sol", themeAmethyst: "Ametista",
    themePaper: "Papel", themeRose: "Rosa",
    numbers: "Números", size: "Tamanho", resetSize: "Redefinir", arabic: "Arábicos", roman: "Romanos",
    clock: "Relógio",
    handStyle: "Estilo do ponteiro", handBar: "Barra", handArrow: "Seta", handSquare: "Quadrado", handRounded: "Arredondado",
    secondMotion: "Ponteiro dos segundos", secondSmooth: "Suave", secondTick: "Em ticks (por segundo)",
    tickSound: "Som dos segundos", tickSound1: "Som 1", tickSound2: "Som 2", tickSound3: "Som 3",
    tickSound4: "Som 4", tickSound5: "Som 5", tickSound6: "Som 6",
    faceShape: "Forma do relógio", faceCircle: "Círculo", faceSquare: "Quadrado", faceRounded: "Quadrado arredondado",
    faceRectPortrait: "Retângulo (vertical)", faceRectLandscape: "Retângulo (horizontal)",
    faceOvalPortrait: "Oval (vertical)", faceOvalLandscape: "Oval (horizontal)", faceStadium: "Estádio",
    faceArch: "Arco", faceHexagon: "Hexágono", faceOctagon: "Octógono", faceDiamond: "Diamante",
    faceTrapezoid: "Trapézio", faceShield: "Escudo",
    borderStyle: "Estilo da borda", borderSolid: "Sólida", borderThin: "Fina", borderDouble: "Dupla",
    borderDashed: "Tracejada", borderDotted: "Pontilhada", borderRing: "Anel", borderGlow: "Brilho",
    borderRaised: "Relevo", borderClassic: "Clássico",
    colors: "Cores", resetColors: "Redefinir cores",
    bgImages: "Imagens de fundo",
    bgImagesHint: "Escolha um arquivo local, arraste e solte, ou cole (Ctrl+V). As imagens ficam neste dispositivo.",
    bgImageChoose: "Escolher imagem", bgImagePaste: "Colar", bgImageClear: "Limpar",
    bgImageDrop: "Clique, solte ou cole", bgImagePasteFail: "Nenhuma imagem na área de transferência",
    share: "Compartilhar", copyUrl: "Copiar URL das configurações", copied: "Copiado!",
    colorBg: "Fundo", colorFaceBorder: "Borda do relógio", colorFaceBg: "Mostrador", colorNumber: "Números",
    colorMarker: "Marcas", colorMarkerMajor: "Marcas principais", colorHandHour: "Ponteiro das horas",
    colorHandMinute: "Ponteiro dos minutos", colorHandSecond: "Ponteiro dos segundos", colorHub: "Centro", colorHubRing: "Anel central",
  },
  ru: {
    toolbarAria: "Инструменты", fullscreen: "Полный экран", fullscreenTitle: "Полный экран (F)",
    toLight: "Светлая тема", toDark: "Тёмная тема", themeTitle: "Тёмная / Светлая (L)",
    settings: "Настройки", settingsTitle: "Настройки (S)", panelTitle: "Настройки", close: "Закрыть",
    clockAria: "Аналоговые часы", language: "Язык",
    theme: "Тема", themeClassic: "Классика", themeMidnight: "Полночь", themeDaylight: "Дневной свет", themeOcean: "Океан",
    themeBurgundy: "Бордовый", themeForest: "Лес", themeSunset: "Закат", themeAmethyst: "Аметист",
    themePaper: "Бумага", themeRose: "Роза",
    numbers: "Цифры", size: "Размер", resetSize: "Сбросить", arabic: "Арабские", roman: "Римские",
    clock: "Часы",
    handStyle: "Стиль стрелок", handBar: "Полоса", handArrow: "Стрелка", handSquare: "Квадрат", handRounded: "Скругление",
    secondMotion: "Секундная стрелка", secondSmooth: "Плавно", secondTick: "Рывками (каждую секунду)",
    tickSound: "Звук секунд", tickSound1: "Звук 1", tickSound2: "Звук 2", tickSound3: "Звук 3",
    tickSound4: "Звук 4", tickSound5: "Звук 5", tickSound6: "Звук 6",
    faceShape: "Форма часов", faceCircle: "Круг", faceSquare: "Квадрат", faceRounded: "Скруглённый квадрат",
    faceRectPortrait: "Прямоугольник (верт.)", faceRectLandscape: "Прямоугольник (гориз.)",
    faceOvalPortrait: "Овал (верт.)", faceOvalLandscape: "Овал (гориз.)", faceStadium: "Стадион",
    faceArch: "Арка", faceHexagon: "Шестиугольник", faceOctagon: "Восьмиугольник", faceDiamond: "Ромб",
    faceTrapezoid: "Трапеция", faceShield: "Щит",
    borderStyle: "Стиль рамки", borderSolid: "Сплошная", borderThin: "Тонкая", borderDouble: "Двойная",
    borderDashed: "Штриховая", borderDotted: "Пунктир", borderRing: "Кольцо", borderGlow: "Свечение",
    borderRaised: "Объёмная", borderClassic: "Классика",
    colors: "Цвета", resetColors: "Сбросить цвета",
    bgImages: "Фоновые изображения",
    bgImagesHint: "Выберите локальный файл, перетащите или вставьте (Ctrl+V). Изображения хранятся на этом устройстве.",
    bgImageChoose: "Выбрать изображение", bgImagePaste: "Вставить", bgImageClear: "Удалить",
    bgImageDrop: "Клик, перетаскивание или вставка", bgImagePasteFail: "В буфере обмена нет изображения",
    share: "Поделиться", copyUrl: "Копировать URL настроек", copied: "Скопировано!",
    colorBg: "Фон", colorFaceBorder: "Рамка часов", colorFaceBg: "Циферблат", colorNumber: "Цифры",
    colorMarker: "Метки", colorMarkerMajor: "Основные метки", colorHandHour: "Часовая стрелка",
    colorHandMinute: "Минутная стрелка", colorHandSecond: "Секундная стрелка", colorHub: "Центр", colorHubRing: "Центральное кольцо",
  },
  hi: {
    toolbarAria: "उपकरण", fullscreen: "पूर्ण स्क्रीन", fullscreenTitle: "पूर्ण स्क्रीन (F)",
    toLight: "लाइट मोड पर जाएँ", toDark: "डार्क मोड पर जाएँ", themeTitle: "डार्क / लाइट (L)",
    settings: "सेटिंग्स", settingsTitle: "सेटिंग्स (S)", panelTitle: "सेटिंग्स", close: "बंद करें",
    clockAria: "एनालॉग घड़ी", language: "भाषा",
    theme: "थीम", themeClassic: "क्लासिक", themeMidnight: "मध्यरात्रि", themeDaylight: "दिन का उजाला", themeOcean: "समुद्री नीला",
    themeBurgundy: "बरगंडी", themeForest: "वन", themeSunset: "सूर्यास्त", themeAmethyst: "नीलम",
    themePaper: "कागज़", themeRose: "गुलाबी",
    numbers: "अंक", size: "आकार", resetSize: "रीसेट", arabic: "अरबी", roman: "रोमन",
    clock: "घड़ी",
    handStyle: "सुई का प्रकार", handBar: "पट्टी", handArrow: "तीर", handSquare: "चौकोर", handRounded: "गोल",
    secondMotion: "सेकंड सुई", secondSmooth: "स्मूद", secondTick: "टिक (प्रति सेकंड)",
    tickSound: "टिक ध्वनि", tickSound1: "ध्वनि 1", tickSound2: "ध्वनि 2", tickSound3: "ध्वनि 3",
    tickSound4: "ध्वनि 4", tickSound5: "ध्वनि 5", tickSound6: "ध्वनि 6",
    faceShape: "घड़ी का आकार", faceCircle: "वृत्त", faceSquare: "वर्ग", faceRounded: "गोल वर्ग",
    faceRectPortrait: "आयत (खड़ा)", faceRectLandscape: "आयत (चौड़ा)",
    faceOvalPortrait: "अंडाकार (खड़ा)", faceOvalLandscape: "अंडाकार (चौड़ा)", faceStadium: "स्टेडियम",
    faceArch: "मेहराब", faceHexagon: "षट्कोण", faceOctagon: "अष्टकोण", faceDiamond: "हीरा",
    faceTrapezoid: "समलम्ब", faceShield: "ढाल",
    borderStyle: "किनारा शैली", borderSolid: "ठोस", borderThin: "पतला", borderDouble: "दोहरा",
    borderDashed: "धराशायी", borderDotted: "बिंदुदार", borderRing: "वलय", borderGlow: "चमक",
    borderRaised: "उभरा", borderClassic: "क्लासिक",
    colors: "रंग", resetColors: "रंग रीसेट करें",
    bgImages: "पृष्ठभूमि चित्र",
    bgImagesHint: "स्थानीय फ़ाइल चुनें, ड्रैग और ड्रॉप करें, या पेस्ट करें (Ctrl+V)। चित्र इसी डिवाइस पर रहेंगे।",
    bgImageChoose: "चित्र चुनें", bgImagePaste: "पेस्ट", bgImageClear: "हटाएँ",
    bgImageDrop: "क्लिक, ड्रॉप या पेस्ट", bgImagePasteFail: "क्लिपबोर्ड में चित्र नहीं है",
    share: "साझा करें", copyUrl: "सेटिंग्स URL कॉपी करें", copied: "कॉपी किया गया!",
    colorBg: "पृष्ठभूमि", colorFaceBorder: "घड़ी का किनारा", colorFaceBg: "डायल", colorNumber: "अंक",
    colorMarker: "निशान", colorMarkerMajor: "मुख्य निशान", colorHandHour: "घंटा सुई",
    colorHandMinute: "मिनट सुई", colorHandSecond: "सेकंड सुई", colorHub: "केंद्र", colorHubRing: "केंद्र वलय",
  },
  ar: {
    toolbarAria: "أدوات", fullscreen: "ملء الشاشة", fullscreenTitle: "ملء الشاشة (F)",
    toLight: "التبديل إلى الوضع الفاتح", toDark: "التبديل إلى الوضع الداكن", themeTitle: "داكن / فاتح (L)",
    settings: "الإعدادات", settingsTitle: "الإعدادات (S)", panelTitle: "الإعدادات", close: "إغلاق",
    clockAria: "ساعة تناظرية", language: "اللغة",
    theme: "السمة", themeClassic: "كلاسيكي", themeMidnight: "منتصف الليل", themeDaylight: "ضوء النهار", themeOcean: "أزرق محيطي",
    themeBurgundy: "عنابي", themeForest: "غابة", themeSunset: "غروب", themeAmethyst: "جمشت",
    themePaper: "ورقي", themeRose: "وردي",
    numbers: "الأرقام", size: "الحجم", resetSize: "إعادة تعيين", arabic: "عربية", roman: "رومانية",
    clock: "الساعة",
    handStyle: "شكل العقارب", handBar: "شريط", handArrow: "سهم", handSquare: "مربع", handRounded: "دائري",
    secondMotion: "عقرب الثواني", secondSmooth: "سلس", secondTick: "نقرة كل ثانية",
    tickSound: "صوت الثواني", tickSound1: "صوت 1", tickSound2: "صوت 2", tickSound3: "صوت 3",
    tickSound4: "صوت 4", tickSound5: "صوت 5", tickSound6: "صوت 6",
    faceShape: "شكل الساعة", faceCircle: "دائرة", faceSquare: "مربع", faceRounded: "مربع مستدير",
    faceRectPortrait: "مستطيل (عمودي)", faceRectLandscape: "مستطيل (أفقي)",
    faceOvalPortrait: "بيضاوي (عمودي)", faceOvalLandscape: "بيضاوي (أفقي)", faceStadium: "ملعب",
    faceArch: "قوس", faceHexagon: "سداسي", faceOctagon: "ثماني", faceDiamond: "ماسة",
    faceTrapezoid: "شبه منحرف", faceShield: "درع",
    borderStyle: "نمط الحدود", borderSolid: "خط متصل", borderThin: "خط رفيع", borderDouble: "خط مزدوج",
    borderDashed: "خط متقطع", borderDotted: "خط منقّط", borderRing: "حلقة", borderGlow: "توهج",
    borderRaised: "بارز", borderClassic: "كلاسيكي",
    colors: "الألوان", resetColors: "إعادة تعيين الألوان",
    bgImages: "صور الخلفية",
    bgImagesHint: "اختر ملفًا محليًا أو اسحب وأفلت أو الصق (Ctrl+V). تُحفظ الصور على هذا الجهاز فقط.",
    bgImageChoose: "اختر صورة", bgImagePaste: "لصق", bgImageClear: "مسح",
    bgImageDrop: "انقر أو أفلت أو الصق", bgImagePasteFail: "لا توجد صورة في الحافظة",
    share: "مشاركة", copyUrl: "نسخ رابط الإعدادات", copied: "تم النسخ!",
    colorBg: "الخلفية", colorFaceBorder: "إطار الساعة", colorFaceBg: "وجه الساعة", colorNumber: "الأرقام",
    colorMarker: "العلامات", colorMarkerMajor: "العلامات الرئيسية", colorHandHour: "عقرب الساعات",
    colorHandMinute: "عقرب الدقائق", colorHandSecond: "عقرب الثواني", colorHub: "المركز", colorHubRing: "الحلقة المركزية",
  },
};

const RTL_LANGS = new Set(["ar"]);
let currentLang = "en";

function t(key) {
  const dict = I18N[currentLang] || I18N.en;
  return dict[key] ?? I18N.en[key] ?? key;
}

function applyLanguage(lang) {
  currentLang = I18N[lang] ? lang : "en";
  const html = document.documentElement;
  html.lang = currentLang;
  html.dir = RTL_LANGS.has(currentLang) ? "rtl" : "ltr";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  });

  syncColorModeButton(document.getElementById("btn-color-mode"), html.dataset.colorMode);
}

function themeI18nKey(key) {
  return "theme" + key.charAt(0).toUpperCase() + key.slice(1);
}

function themeSwatch(key, mode = "dark") {
  const c = themePalette(key, mode);
  if (!c) return "transparent";
  return `linear-gradient(135deg, ${c.bg} 0 50%, ${c.handSecond} 50% 100%)`;
}

const ROMAN = {
  12: "XII", 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI",
  7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI",
};

const ARABIC = {
  12: "12", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6",
  7: "7", 8: "8", 9: "9", 10: "10", 11: "11",
};

const COLOR_KEYS = [
  { key: "bg", i18n: "colorBg", css: "--color-bg" },
  { key: "faceBorder", i18n: "colorFaceBorder", css: "--color-face-border" },
  { key: "faceBg", i18n: "colorFaceBg", css: "--color-face-bg" },
  { key: "number", i18n: "colorNumber", css: "--color-number" },
  { key: "marker", i18n: "colorMarker", css: "--color-marker" },
  { key: "markerMajor", i18n: "colorMarkerMajor", css: "--color-marker-major" },
  { key: "handHour", i18n: "colorHandHour", css: "--color-hand-hour" },
  { key: "handMinute", i18n: "colorHandMinute", css: "--color-hand-minute" },
  { key: "handSecond", i18n: "colorHandSecond", css: "--color-hand-second" },
  { key: "hub", i18n: "colorHub", css: "--color-hub" },
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

/* ==========================================================================
   Themes — 배경 + 시계 색을 한 번에 바꾸는 프리셋
   mode: dark/light 는 UI 패널/그림자 톤을 결정합니다.
   ========================================================================== */

const THEMES = {
  classic: {
    dark: { ...PALETTES.dark },
    light: { ...PALETTES.light },
  },
  ocean: {
    dark: {
      bg: "#0a1a2f", faceBg: "#10243d", faceBorder: "#1d3e63",
      number: "#cfe3ff", marker: "#3a5f8a", markerMajor: "#7fa8d8",
      handHour: "#dbe9ff", handMinute: "#ffffff", handSecond: "#4da3ff",
      hub: "#eaf2ff", hubRing: "rgba(77, 163, 255, 0.45)",
    },
    light: {
      bg: "#e8f1fb", faceBg: "#ffffff", faceBorder: "#b8d4f0",
      number: "#1c3a5e", marker: "#a9c6e6", markerMajor: "#4a77a8",
      handHour: "#12395e", handMinute: "#001a33", handSecond: "#0a84ff",
      hub: "#12395e", hubRing: "rgba(10, 132, 255, 0.4)",
    },
  },
  burgundy: {
    dark: {
      bg: "#1f0a10", faceBg: "#2c0f16", faceBorder: "#55212c",
      number: "#f0d0d6", marker: "#6e2f3b", markerMajor: "#a85462",
      handHour: "#f3dde1", handMinute: "#ffffff", handSecond: "#e05a74",
      hub: "#f7e6e9", hubRing: "rgba(224, 90, 116, 0.45)",
    },
    light: {
      bg: "#f7e9ec", faceBg: "#fffafb", faceBorder: "#e6c2ca",
      number: "#5e2029", marker: "#dba9b3", markerMajor: "#a85462",
      handHour: "#4a1820", handMinute: "#2b0d12", handSecond: "#c8324f",
      hub: "#4a1820", hubRing: "rgba(200, 50, 79, 0.4)",
    },
  },
  forest: {
    dark: {
      bg: "#0b1a12", faceBg: "#10241a", faceBorder: "#1e4230",
      number: "#d0ecd9", marker: "#356b4c", markerMajor: "#6fb389",
      handHour: "#dcf2e4", handMinute: "#ffffff", handSecond: "#43c47d",
      hub: "#eafaf0", hubRing: "rgba(67, 196, 125, 0.45)",
    },
    light: {
      bg: "#e7f4ec", faceBg: "#fafffb", faceBorder: "#bfe0cc",
      number: "#1c4230", marker: "#a5d3b8", markerMajor: "#4a8a66",
      handHour: "#143024", handMinute: "#06180f", handSecond: "#12a15a",
      hub: "#143024", hubRing: "rgba(18, 161, 90, 0.4)",
    },
  },
  sunset: {
    dark: {
      bg: "#2a1206", faceBg: "#3a1a0b", faceBorder: "#5e3016",
      number: "#ffe4cf", marker: "#8a4a28", markerMajor: "#d08a55",
      handHour: "#ffe9d6", handMinute: "#ffffff", handSecond: "#ff8a3d",
      hub: "#fff2e6", hubRing: "rgba(255, 138, 61, 0.45)",
    },
    light: {
      bg: "#fdeee0", faceBg: "#fffaf5", faceBorder: "#f2d5b8",
      number: "#6e3a16", marker: "#e6c199", markerMajor: "#c07a3a",
      handHour: "#5e3016", handMinute: "#3a1c08", handSecond: "#f57722",
      hub: "#5e3016", hubRing: "rgba(245, 119, 34, 0.4)",
    },
  },
  amethyst: {
    dark: {
      bg: "#160a2a", faceBg: "#1f0f3a", faceBorder: "#3a2160",
      number: "#e2d4ff", marker: "#573a8a", markerMajor: "#9a7fd8",
      handHour: "#ece0ff", handMinute: "#ffffff", handSecond: "#a86bff",
      hub: "#f2eaff", hubRing: "rgba(168, 107, 255, 0.45)",
    },
    light: {
      bg: "#f0eafb", faceBg: "#fdfbff", faceBorder: "#d6c6f0",
      number: "#3a2160", marker: "#c3aee6", markerMajor: "#7f5fc0",
      handHour: "#2e1a4e", handMinute: "#180a2e", handSecond: "#8a4fe0",
      hub: "#2e1a4e", hubRing: "rgba(138, 79, 224, 0.4)",
    },
  },
  paper: {
    dark: {
      bg: "#241f17", faceBg: "#2f281d", faceBorder: "#4a4030",
      number: "#e8dcc4", marker: "#6e6045", markerMajor: "#a89570",
      handHour: "#f0e6d2", handMinute: "#ffffff", handSecond: "#d9a94a",
      hub: "#f5eedd", hubRing: "rgba(217, 169, 74, 0.45)",
    },
    light: {
      bg: "#f3ece0", faceBg: "#fbf6ec", faceBorder: "#d8c9ad",
      number: "#4a3f2f", marker: "#cbb891", markerMajor: "#8a7856",
      handHour: "#3a3020", handMinute: "#000000", handSecond: "#c08a2d",
      hub: "#3a3020", hubRing: "rgba(192, 138, 45, 0.45)",
    },
  },
  rose: {
    dark: {
      bg: "#2a1218", faceBg: "#3a1a22", faceBorder: "#5e2e38",
      number: "#ffd8e0", marker: "#7a3d4a", markerMajor: "#b56b7c",
      handHour: "#ffe0e6", handMinute: "#ffffff", handSecond: "#ff6b8a",
      hub: "#fff0f3", hubRing: "rgba(255, 107, 138, 0.45)",
    },
    light: {
      bg: "#fbeef0", faceBg: "#fff7f8", faceBorder: "#f0cdd4",
      number: "#6e3a44", marker: "#e0adb8", markerMajor: "#c07886",
      handHour: "#4a2229", handMinute: "#000000", handSecond: "#e0567a",
      hub: "#4a2229", hubRing: "rgba(224, 86, 122, 0.45)",
    },
  },
};

function themePalette(themeKey, mode) {
  const theme = THEMES[themeKey] || THEMES.classic;
  return theme[mode] || theme.dark || theme.light;
}

const DEFAULT_SETTINGS = {
  language: "en",
  theme: "classic",
  colorMode: "dark",
  numberSize: 1,
  clockSize: 0.75,
  numeral: "arabic",
  handStyle: "bar",
  secondMotion: "smooth",
  tickSound: false,
  tickSoundId: "01",
  faceShape: "circle",
  borderStyle: "solid",
  colors: { ...PALETTES.dark, hubRing: PALETTES.dark.hubRing },
};

const TICK_SOUND_IDS = new Set(["01", "02", "03", "04", "05", "06"]);

function tickSoundUrl(id) {
  const safe = TICK_SOUND_IDS.has(id) ? id : "01";
  return `sound/second_sound_${safe}.mp3`;
}

const FACE_SHAPES = new Set([
  "circle", "square", "rounded",
  "rect-portrait", "rect-landscape",
  "oval-portrait", "oval-landscape", "stadium", "arch",
  "hexagon", "octagon", "diamond", "trapezoid", "shield",
]);

function cloneDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    colors: { ...DEFAULT_SETTINGS.colors },
  };
}

/* ==========================================================================
   Share — 설정값을 URL로 추출/복원
   ========================================================================== */

const SHARE_PARAM = "s";

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return decodeURIComponent(escape(atob(normalized + pad)));
}

function normalizeSettings(saved) {
  const src = saved && typeof saved === "object" ? saved : {};
  let themeKey = src.theme || "classic";
  let mode = src.colorMode === "light" ? "light" : "dark";
  if (themeKey === "midnight") { themeKey = "classic"; mode = "dark"; }
  else if (themeKey === "daylight") { themeKey = "classic"; mode = "light"; }
  if (!THEMES[themeKey]) themeKey = "classic";
  const palette = themePalette(themeKey, mode);
  const faceShape = FACE_SHAPES.has(src.faceShape) ? src.faceShape : "circle";
  const secondMotion = src.secondMotion === "tick" ? "tick" : "smooth";
  const tickSoundId = TICK_SOUND_IDS.has(src.tickSoundId) ? src.tickSoundId : "01";
  return {
    ...cloneDefaults(),
    ...src,
    theme: themeKey,
    colorMode: mode,
    faceShape,
    secondMotion,
    tickSound: Boolean(src.tickSound) && secondMotion === "tick",
    tickSoundId,
    clockSize: clampClockSize(src.clockSize ?? cloneDefaults().clockSize),
    colors: { ...palette, ...(src.colors || {}) },
  };
}

function readSharedSettings() {
  try {
    const fromHash = new URLSearchParams(
      window.location.hash.replace(/^#/, "")
    ).get(SHARE_PARAM);
    const fromQuery = new URLSearchParams(window.location.search).get(SHARE_PARAM);
    const raw = fromHash || fromQuery;
    if (!raw) return null;
    return JSON.parse(b64urlDecode(raw));
  } catch {
    return null;
  }
}

function clearSharedParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(SHARE_PARAM);
    url.hash = "";
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch {
    /* ignore */
  }
}

function buildShareUrl(settings) {
  const payload = {
    language: settings.language,
    theme: settings.theme,
    colorMode: settings.colorMode,
    numberSize: settings.numberSize,
    clockSize: settings.clockSize,
    numeral: settings.numeral,
    handStyle: settings.handStyle,
    secondMotion: settings.secondMotion,
    tickSound: settings.tickSound,
    tickSoundId: settings.tickSoundId,
    faceShape: settings.faceShape,
    borderStyle: settings.borderStyle,
    colors: settings.colors,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${SHARE_PARAM}=${encoded}`;
  return url.toString();
}

class SettingsManager {
  constructor(root = document.documentElement) {
    this.root = root;
    this.settings = cloneDefaults();
    this._listeners = new Set();
  }

  load() {
    const shared = readSharedSettings();
    if (shared) {
      this.settings = normalizeSettings(shared);
      this.save();
      clearSharedParam();
      return this.apply();
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.apply();
      this.settings = normalizeSettings(JSON.parse(raw));
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
    this.root.dataset.secondMotion = s.secondMotion === "tick" ? "tick" : "smooth";
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

    applyLanguage(s.language);
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

  applyThemeMode(themeKey, mode) {
    const theme = THEMES[themeKey];
    if (!theme) return;
    const m = theme[mode] ? mode : theme.dark ? "dark" : "light";
    this.settings.theme = themeKey;
    this.settings.colorMode = m;
    this.settings.colors = { ...themePalette(themeKey, m) };
    this.apply();
    this._syncColorInputs();
    this.save();
  }

  applyTheme(themeKey) {
    this.applyThemeMode(themeKey, this.settings.colorMode);
  }

  toggleColorMode() {
    const next = this.settings.colorMode === "dark" ? "light" : "dark";
    this.applyThemeMode(this.settings.theme || "classic", next);
  }

  resetColors() {
    this.applyThemeMode(this.settings.theme || "classic", this.settings.colorMode);
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

class TickSoundPlayer {
  constructor() {
    this.enabled = false;
    this.soundId = "01";
    this._ctx = null;
    this._buffer = null;
    this._slices = [];
    this._index = 0;
    this._loadToken = 0;
    this._gain = null;
  }

  _ensureContext() {
    if (!this._ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._ctx = new AC();
      this._gain = this._ctx.createGain();
      this._gain.gain.value = 0.85;
      this._gain.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  async unlock() {
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  async setSoundId(id) {
    const next = TICK_SOUND_IDS.has(id) ? id : "01";
    if (next === this.soundId && this._buffer) {
      this.soundId = next;
      return;
    }
    this.soundId = next;
    await this._load(next);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  async _load(id) {
    const token = ++this._loadToken;
    const ctx = this._ensureContext();
    if (!ctx) return;
    try {
      const res = await fetch(tickSoundUrl(id));
      if (!res.ok) throw new Error("fetch failed");
      const raw = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(raw.slice(0));
      if (token !== this._loadToken) return;
      this._buffer = buffer;
      this._slices = detectTickSlices(buffer);
      this._index = 0;
    } catch {
      if (token !== this._loadToken) return;
      this._buffer = null;
      this._slices = [];
    }
  }

  playTick() {
    if (!this.enabled || !this._buffer || !this._slices.length) return;
    const ctx = this._ensureContext();
    if (!ctx || ctx.state !== "running") {
      this.unlock();
      return;
    }
    const slice = this._slices[this._index % this._slices.length];
    this._index = (this._index + 1) % this._slices.length;
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    src.connect(this._gain || ctx.destination);
    try {
      src.start(ctx.currentTime, slice.start, slice.duration);
    } catch {
      /* ignore */
    }
  }
}

/** Find per-tick segments inside a multi-tick recording. */
function detectTickSlices(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const duration = buffer.duration;
  const hop = Math.max(1, Math.floor(sr * 0.01));
  const win = Math.max(hop, Math.floor(sr * 0.025));
  const energies = [];
  for (let i = 0; i + win < data.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = data[i + j];
      sum += v * v;
    }
    energies.push({ t: i / sr, e: sum / win });
  }
  if (!energies.length) {
    return [{ start: 0, duration: Math.min(0.2, duration) }];
  }

  const sorted = energies.map((x) => x.e).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const peak = sorted[sorted.length - 1] || 0;
  const threshold = Math.max(median * 8, peak * 0.18, 1e-8);
  const minGap = 0.35;

  const onsets = [];
  let last = -Infinity;
  let armed = true;
  for (let i = 1; i < energies.length - 1; i++) {
    const prev = energies[i - 1].e;
    const cur = energies[i].e;
    const next = energies[i + 1].e;
    const t = energies[i].t;
    if (armed && cur >= threshold && cur >= prev && cur >= next && t - last >= minGap) {
      onsets.push(Math.max(0, t - 0.012));
      last = t;
      armed = false;
    }
    if (cur < threshold * 0.45) armed = true;
  }

  if (onsets.length < 2) {
    // Fallback: assume 1 Hz ticks across the whole file.
    const count = Math.max(1, Math.round(duration));
    const step = duration / count;
    const slices = [];
    for (let i = 0; i < count; i++) {
      slices.push({
        start: i * step,
        duration: Math.min(0.28, step * 0.9),
      });
    }
    return slices;
  }

  const slices = [];
  for (let i = 0; i < onsets.length; i++) {
    const start = onsets[i];
    const end = i + 1 < onsets.length ? onsets[i + 1] : Math.min(duration, start + 0.28);
    const dur = Math.max(0.05, Math.min(0.35, end - start - 0.02));
    slices.push({ start, duration: dur });
  }
  return slices;
}

class AnalogClock {
  constructor(root) {
    this.root = root;
    this.hourHand = root.querySelector(".hand--hour");
    this.minuteHand = root.querySelector(".hand--minute");
    this.secondHand = root.querySelector(".hand--second");
    this._rafId = null;
    this._intervalId = null;
    this._running = false;
    this.secondMotion = "smooth";
    this.tickSound = null;
    this._lastTickSec = null;
  }

  setSecondMotion(mode) {
    this.secondMotion = mode === "tick" ? "tick" : "smooth";
    if (this.secondMotion !== "tick") this._lastTickSec = null;
  }

  setTickSoundPlayer(player) {
    this.tickSound = player;
  }

  static getAngles(date = new Date(), secondMotion = "smooth") {
    const ms = date.getMilliseconds();
    const continuous = date.getSeconds() + ms / 1000;
    const s = secondMotion === "tick" ? date.getSeconds() : continuous;
    const m = date.getMinutes() + continuous / 60;
    const h = (date.getHours() % 12) + m / 60;
    return { hour: h * 30, minute: m * 6, second: s * 6 };
  }

  setHandRotation(el, degrees) {
    if (!el) return;
    el.style.transform = `rotate(${degrees}deg)`;
  }

  tick() {
    const now = new Date();
    const { hour, minute, second } = AnalogClock.getAngles(now, this.secondMotion);
    this.setHandRotation(this.hourHand, hour);
    this.setHandRotation(this.minuteHand, minute);
    this.setHandRotation(this.secondHand, second);

    if (this.secondMotion === "tick") {
      const sec = now.getSeconds();
      if (this._lastTickSec === null) {
        this._lastTickSec = sec;
      } else if (sec !== this._lastTickSec) {
        this._lastTickSec = sec;
        this.tickSound?.playTick();
      }
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      this.tick();
      this._rafId = requestAnimationFrame(loop);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.setSecondMotion("tick");
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
    { key: "hubRing", i18n: "colorHubRing", css: "--color-hub-ring" },
  ];

  allKeys.forEach(({ key, i18n }) => {
    const label = t(i18n);
    const row = document.createElement("label");
    row.className = "settings__color-row";
    const input = document.createElement("input");
    input.type = "color";
    input.dataset.colorKey = key;
    input.dataset.i18nLabel = i18n;
    input.value = toHex(settings.colors[key] ?? "#000000");
    input.setAttribute("aria-label", label);
    const span = document.createElement("span");
    span.dataset.i18n = i18n;
    span.textContent = label;
    row.append(input, span);
    container.appendChild(row);
  });
}

function buildThemeList(list, selectedKey, mode = "dark") {
  if (!list) return;
  list.replaceChildren();
  Object.keys(THEMES).forEach((key) => {
    const i18nKey = themeI18nKey(key);
    const li = document.createElement("li");
    li.className = "theme-select__option";
    li.setAttribute("role", "option");
    li.dataset.theme = key;
    li.tabIndex = -1;
    li.setAttribute("aria-selected", String(key === selectedKey));

    const sw = document.createElement("span");
    sw.className = "theme-swatch";
    sw.style.background = themeSwatch(key, mode);
    sw.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "theme-select__name";
    name.dataset.i18n = i18nKey;
    name.textContent = t(i18nKey);

    li.append(sw, name);
    list.appendChild(li);
  });
}

function syncTickSoundControls(settings) {
  const wrap = document.getElementById("tick-sound-settings");
  const check = document.getElementById("set-tick-sound");
  const file = document.getElementById("set-tick-sound-file");
  const isTick = settings.secondMotion === "tick";
  if (wrap) wrap.hidden = !isTick;
  if (check) {
    check.checked = Boolean(settings.tickSound) && isTick;
    check.disabled = !isTick;
  }
  if (file) {
    file.value = TICK_SOUND_IDS.has(settings.tickSoundId) ? settings.tickSoundId : "01";
    file.disabled = !isTick || !settings.tickSound;
  }
}

function bindSettingsUI(settingsMgr, tickPlayer) {
  const panel = document.getElementById("settings-panel");
  const btnSettings = document.getElementById("btn-settings");
  const btnColorMode = document.getElementById("btn-color-mode");
  const slider = document.getElementById("set-number-size");
  const outSize = document.getElementById("out-number-size");
  const clockSlider = document.getElementById("set-clock-size");
  const outClockSize = document.getElementById("out-clock-size");
  const languageSelect = document.getElementById("set-language");
  const themeSelectRoot = document.getElementById("theme-select");
  const themeTrigger = document.getElementById("theme-select-trigger");
  const themeSwatchEl = document.getElementById("theme-select-swatch");
  const themeNameEl = document.getElementById("theme-select-name");
  const themeList = document.getElementById("theme-select-list");
  const handSelect = document.getElementById("set-hand-style");
  const secondMotionSelect = document.getElementById("set-second-motion");
  const tickSoundCheck = document.getElementById("set-tick-sound");
  const tickSoundFile = document.getElementById("set-tick-sound-file");
  const faceSelect = document.getElementById("set-face-shape");
  const borderSelect = document.getElementById("set-border-style");
  const colorContainer = document.getElementById("color-inputs");

  const updateThemeTrigger = (themeKey) => {
    const mode = settingsMgr.settings.colorMode;
    if (themeSwatchEl) themeSwatchEl.style.background = themeSwatch(themeKey, mode);
    if (themeNameEl) {
      const i18nKey = themeI18nKey(themeKey);
      themeNameEl.dataset.i18n = i18nKey;
      themeNameEl.textContent = t(i18nKey);
    }
    themeList?.querySelectorAll("[role='option']").forEach((li) => {
      li.setAttribute("aria-selected", String(li.dataset.theme === themeKey));
      const sw = li.querySelector(".theme-swatch");
      if (sw) sw.style.background = themeSwatch(li.dataset.theme, mode);
    });
  };

  const closeThemeList = () => {
    if (!themeList) return;
    themeList.hidden = true;
    themeTrigger?.setAttribute("aria-expanded", "false");
  };

  const openThemeList = () => {
    if (!themeList) return;
    themeList.hidden = false;
    themeTrigger?.setAttribute("aria-expanded", "true");
    themeList.querySelector("[aria-selected='true']")?.focus();
  };

  buildThemeList(themeList, settingsMgr.settings.theme, settingsMgr.settings.colorMode);
  updateThemeTrigger(settingsMgr.settings.theme);
  const btnResetColors = document.getElementById("btn-reset-colors");
  const btnResetNumberSize = document.getElementById("btn-reset-number-size");
  const btnResetClockSize = document.getElementById("btn-reset-clock-size");
  const btnCopyUrl = document.getElementById("btn-copy-url");
  const shareUrlInput = document.getElementById("share-url");

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

  btnResetNumberSize?.addEventListener("click", () => {
    const v = DEFAULT_SETTINGS.numberSize;
    if (slider) slider.value = String(v);
    if (outSize) outSize.textContent = `${Math.round(v * 100)}%`;
    settingsMgr.set({ numberSize: v });
  });

  btnResetClockSize?.addEventListener("click", () => {
    const v = DEFAULT_SETTINGS.clockSize;
    if (clockSlider) clockSlider.value = String(v);
    if (outClockSize) outClockSize.textContent = `${Math.round(v * 100)}%`;
    settingsMgr.set({ clockSize: v });
  });

  document.querySelectorAll('input[name="numeral"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) settingsMgr.set({ numeral: radio.value });
    });
  });

  languageSelect?.addEventListener("change", () => {
    settingsMgr.set({ language: languageSelect.value });
  });

  themeTrigger?.addEventListener("click", () => {
    if (themeList?.hidden) openThemeList();
    else closeThemeList();
  });

  themeList?.addEventListener("click", (e) => {
    const option = e.target.closest("[data-theme]");
    if (!option) return;
    settingsMgr.applyTheme(option.dataset.theme);
    closeThemeList();
    themeTrigger?.focus();
  });

  themeList?.addEventListener("keydown", (e) => {
    const options = [...themeList.querySelectorAll("[role='option']")];
    const idx = options.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      options[Math.min(idx + 1, options.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      options[Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      document.activeElement?.click();
    } else if (e.key === "Escape") {
      closeThemeList();
      themeTrigger?.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (themeSelectRoot && !themeSelectRoot.contains(e.target)) closeThemeList();
  });

  handSelect?.addEventListener("change", () => {
    settingsMgr.set({ handStyle: handSelect.value });
  });

  secondMotionSelect?.addEventListener("change", () => {
    const secondMotion = secondMotionSelect.value === "tick" ? "tick" : "smooth";
    const patch = { secondMotion };
    if (secondMotion !== "tick") patch.tickSound = false;
    settingsMgr.set(patch);
    syncTickSoundControls(settingsMgr.settings);
  });

  tickSoundCheck?.addEventListener("change", async () => {
    const on = Boolean(tickSoundCheck.checked);
    if (on) await tickPlayer?.unlock();
    settingsMgr.set({ tickSound: on && settingsMgr.settings.secondMotion === "tick" });
    syncTickSoundControls(settingsMgr.settings);
    if (tickPlayer) {
      tickPlayer.setEnabled(settingsMgr.settings.tickSound);
      if (settingsMgr.settings.tickSound) {
        await tickPlayer.setSoundId(settingsMgr.settings.tickSoundId);
      }
    }
  });

  tickSoundFile?.addEventListener("change", async () => {
    const id = tickSoundFile.value;
    settingsMgr.set({ tickSoundId: id });
    if (tickPlayer) {
      await tickPlayer.unlock();
      await tickPlayer.setSoundId(id);
      if (settingsMgr.settings.tickSound) tickPlayer.playTick();
    }
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

  let copyResetTimer = null;
  btnCopyUrl?.addEventListener("click", async () => {
    const url = buildShareUrl(settingsMgr.settings);
    if (shareUrlInput) {
      shareUrlInput.hidden = false;
      shareUrlInput.value = url;
      shareUrlInput.focus();
      shareUrlInput.select();
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      if (shareUrlInput) {
        shareUrlInput.select();
        try { copied = document.execCommand("copy"); } catch { /* ignore */ }
      }
    }
    if (copied) {
      btnCopyUrl.textContent = t("copied");
      btnCopyUrl.classList.add("is-copied");
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        btnCopyUrl.textContent = t("copyUrl");
        btnCopyUrl.classList.remove("is-copied");
      }, 1800);
    }
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
    if (languageSelect) languageSelect.value = s.language;
    updateThemeTrigger(s.theme);
    if (handSelect) handSelect.value = s.handStyle;
    if (secondMotionSelect) secondMotionSelect.value = s.secondMotion === "tick" ? "tick" : "smooth";
    syncTickSoundControls(s);
    if (faceSelect) faceSelect.value = s.faceShape;
    if (borderSelect) borderSelect.value = s.borderStyle;
    syncColorModeButton(btnColorMode, s.colorMode);
  });
}

function syncColorModeButton(btn, mode) {
  if (!btn) return;
  btn.setAttribute("aria-label", mode === "dark" ? t("toLight") : t("toDark"));
  btn.setAttribute("title", t("themeTitle"));
}

function syncUIFromSettings(settingsMgr) {
  const s = settingsMgr.settings;
  const slider = document.getElementById("set-number-size");
  const outSize = document.getElementById("out-number-size");
  const clockSlider = document.getElementById("set-clock-size");
  const outClockSize = document.getElementById("out-clock-size");
  if (slider) slider.value = String(s.numberSize);
  if (outSize) outSize.textContent = `${Math.round(s.numberSize * 100)}%`;
  if (clockSlider) clockSlider.value = String(s.clockSize ?? 0.75);
  if (outClockSize) outClockSize.textContent = `${Math.round((s.clockSize ?? 0.75) * 100)}%`;
  document.querySelectorAll('input[name="numeral"]').forEach((r) => {
    r.checked = r.value === s.numeral;
  });
  const languageSelect = document.getElementById("set-language");
  const themeSwatchEl = document.getElementById("theme-select-swatch");
  const themeNameEl = document.getElementById("theme-select-name");
  const handSelect = document.getElementById("set-hand-style");
  const secondMotionSelect = document.getElementById("set-second-motion");
  const faceSelect = document.getElementById("set-face-shape");
  const borderSelect = document.getElementById("set-border-style");
  if (languageSelect) languageSelect.value = s.language ?? "en";
  const themeKey = s.theme ?? "classic";
  if (themeSwatchEl) themeSwatchEl.style.background = themeSwatch(themeKey, s.colorMode ?? "dark");
  if (themeNameEl) {
    themeNameEl.dataset.i18n = themeI18nKey(themeKey);
    themeNameEl.textContent = t(themeI18nKey(themeKey));
  }
  if (handSelect) handSelect.value = s.handStyle;
  if (secondMotionSelect) secondMotionSelect.value = s.secondMotion === "tick" ? "tick" : "smooth";
  syncTickSoundControls(s);
  if (faceSelect) faceSelect.value = s.faceShape;
  if (borderSelect) borderSelect.value = s.borderStyle ?? "solid";
  syncColorModeButton(document.getElementById("btn-color-mode"), s.colorMode);
}

const CLOCK_SIZE_MIN = 0.35;
const CLOCK_SIZE_MAX = 1;

function clampClockSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return CLOCK_SIZE_MAX * 0.75;
  return Math.min(CLOCK_SIZE_MAX, Math.max(CLOCK_SIZE_MIN, Math.round(n * 100) / 100));
}

function adjustClockSize(settingsMgr, delta) {
  const cur = settingsMgr.settings.clockSize ?? 0.75;
  const next = clampClockSize(cur + delta);
  if (next !== cur) settingsMgr.set({ clockSize: next });
}

function setClockSizeLive(settingsMgr, size) {
  const next = clampClockSize(size);
  settingsMgr.settings.clockSize = next;
  settingsMgr.root.style.setProperty("--clock-scale", String(next));
  return next;
}

function pinchTouchesDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function shouldIgnorePinchZoom(e, settingsPanel) {
  if (settingsPanel && !settingsPanel.hidden) return true;
  if (e.target.closest?.(".settings, .toolbar, input, select, textarea, button, label")) return true;
  return false;
}

function bindPinchZoom(settingsMgr, settingsPanel) {
  let pinching = false;
  let startDist = 0;
  let startSize = 0;

  const endPinch = () => {
    if (!pinching) return;
    pinching = false;
    document.body.classList.remove("pinching-clock");
    settingsMgr.set({ clockSize: settingsMgr.settings.clockSize });
  };

  document.addEventListener(
    "touchstart",
    (e) => {
      if (shouldIgnorePinchZoom(e, settingsPanel)) return;
      if (e.touches.length !== 2) return;
      pinching = true;
      startDist = pinchTouchesDistance(e.touches);
      startSize = settingsMgr.settings.clockSize ?? 0.75;
      document.body.classList.add("pinching-clock");
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!pinching || e.touches.length !== 2) return;
      if (shouldIgnorePinchZoom(e, settingsPanel)) {
        endPinch();
        return;
      }
      if (startDist <= 0) return;
      e.preventDefault();
      const ratio = pinchTouchesDistance(e.touches) / startDist;
      setClockSizeLive(settingsMgr, startSize * ratio);
    },
    { passive: false }
  );

  document.addEventListener("touchend", (e) => {
    if (!pinching) return;
    if (e.touches.length >= 2) return;
    endPinch();
  });

  document.addEventListener("touchcancel", endPinch);
}

function bindWheel(settingsMgr, settingsPanel) {
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) return;
      if (settingsPanel && !settingsPanel.hidden && settingsPanel.contains(e.target)) return;
      if (e.target.closest?.(".settings")) return;
      e.preventDefault();
      adjustClockSize(settingsMgr, e.deltaY < 0 ? 0.05 : -0.05);
    },
    { passive: false }
  );
}

function bindFullscreenAutohide(settingsPanel) {
  let hideTimer = null;
  const isFs = () => Boolean(document.fullscreenElement);

  const hideToolbar = () => {
    if (!isFs()) return;
    if (settingsPanel && !settingsPanel.hidden) return;
    document.body.classList.remove("toolbar-visible");
  };

  const showToolbar = () => {
    if (!isFs()) return;
    document.body.classList.add("toolbar-visible");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideToolbar, 3000);
  };

  document.addEventListener("fullscreenchange", () => {
    clearTimeout(hideTimer);
    if (isFs()) {
      document.body.classList.add("is-fullscreen");
      document.body.classList.remove("toolbar-visible");
    } else {
      document.body.classList.remove("is-fullscreen", "toolbar-visible");
    }
  });

  document.addEventListener("click", () => {
    if (isFs()) showToolbar();
  });
}

function bindKeyboard(fullscreen, settingsPanel, settingsMgr) {
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      adjustClockSize(settingsMgr, 0.05);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      adjustClockSize(settingsMgr, -0.05);
      return;
    }
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

async function init() {
  const settingsMgr = new SettingsManager();
  settingsMgr.load();

  const imageStore = new BackgroundImageStore();
  try {
    await imageStore.hydrate();
  } catch {
    /* IndexedDB unavailable */
  }
  syncBgImageUI(imageStore);

  syncUIFromSettings(settingsMgr);

  const tickPlayer = new TickSoundPlayer();
  tickPlayer.setEnabled(Boolean(settingsMgr.settings.tickSound));
  if (settingsMgr.settings.tickSound) {
    tickPlayer.setSoundId(settingsMgr.settings.tickSoundId).catch(() => {});
  }

  const clock = new AnalogClock(document.querySelector(".clock"));
  clock.setTickSoundPlayer(tickPlayer);
  clock.setSecondMotion(settingsMgr.settings.secondMotion);
  clock.start();

  const fullscreen = new FullscreenController(document.getElementById("btn-fullscreen"));
  const panel = document.getElementById("settings-panel");

  bindSettingsUI(settingsMgr, tickPlayer);
  bindBackgroundImages(imageStore, panel);
  bindKeyboard(fullscreen, panel, settingsMgr);
  bindWheel(settingsMgr, panel);
  bindPinchZoom(settingsMgr, panel);
  bindFullscreenAutohide(panel);

  // Browsers require a user gesture before audio can play.
  const unlockAudioOnce = () => {
    tickPlayer.unlock();
    window.removeEventListener("pointerdown", unlockAudioOnce);
    window.removeEventListener("keydown", unlockAudioOnce);
  };
  window.addEventListener("pointerdown", unlockAudioOnce);
  window.addEventListener("keydown", unlockAudioOnce);

  settingsMgr.onChange((s) => {
    clock.setSecondMotion(s.secondMotion);
    tickPlayer.setEnabled(Boolean(s.tickSound) && s.secondMotion === "tick");
    if (s.tickSound && s.secondMotion === "tick") {
      tickPlayer.setSoundId(s.tickSoundId).catch(() => {});
    }
  });

  window.AnalogClockApp = {
    settings: settingsMgr,
    clock,
    fullscreen,
    images: imageStore,
    tickSound: tickPlayer,
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
