"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const fileInput = byId("photo-file");
  const consent = byId("consent");
  const analyze = byId("analyze");
  const clear = byId("clear");
  const preview = byId("photo-preview");
  const canvas = byId("crop-preview");
  let metadata = null;
  let photo = null;
  let objectUrl = null;
  let generation = 0;
  let controller = null;
  let busy = false;
  let idleTimer = null;
  const idleMs = 120_000;
  const accepted = new Set(["image/jpeg", "image/png", "image/webp"]);

  function announce(message) {
    byId("announcement").textContent = message;
  }
  function error(message = "") {
    byId("error").textContent = message;
    byId("error").hidden = !message;
  }
  function updateControls() {
    analyze.disabled = !metadata || !photo || !consent.checked || busy;
    analyze.textContent = busy ? "모델이 예측하는 중…" : "모델로 테스트";
    clear.disabled = !objectUrl && !photo && !busy && byId("results").hidden;
    byId("results-panel").setAttribute("aria-busy", String(busy));
  }
  function revokePreview() {
    preview.onload = null;
    preview.onerror = null;
    preview.removeAttribute("src");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }
  function reset(message = "", focus = false) {
    generation += 1;
    controller?.abort();
    controller = null;
    busy = false;
    photo = null;
    fileInput.value = "";
    consent.checked = false;
    revokePreview();
    byId("preview-wrap").hidden = true;
    byId("picker").classList.remove("has-photo");
    byId("choose-label").textContent = "사진 선택";
    byId("results").hidden = true;
    byId("loading").hidden = true;
    byId("empty").hidden = false;
    byId("head-results").replaceChildren();
    byId("result-model").textContent = "";
    error();
    clearTimeout(idleTimer);
    idleTimer = null;
    updateControls();
    announce(message);
    if (focus) fileInput.focus();
  }
  function touch() {
    clearTimeout(idleTimer);
    if (objectUrl || photo || busy || !byId("results").hidden) {
      idleTimer = setTimeout(
        () => reset("2분 동안 조작하지 않아 사진과 결과를 비웠습니다.", true),
        idleMs,
      );
    }
  }

  fileInput.addEventListener("change", () => {
    const selected = fileInput.files?.[0];
    reset();
    if (!selected) return;
    if (!accepted.has(selected.type))
      return error(
        "JPG, PNG 또는 WebP 사진을 선택하세요. HEIC 파일은 JPG로 변환해야 합니다.",
      );
    if (!selected.size || selected.size > 10 * 1024 * 1024)
      return error("사진 크기는 0보다 크고 10MB 이하여야 합니다.");
    const current = generation;
    objectUrl = URL.createObjectURL(selected);
    updateControls();
    touch();
    preview.onload = () => {
      if (current !== generation) return;
      if (
        preview.naturalWidth < 224 ||
        preview.naturalHeight < 224 ||
        preview.naturalWidth * preview.naturalHeight > 25_000_000
      ) {
        reset();
        error(
          "사진은 가로·세로 각각 224픽셀 이상, 총 2,500만 픽셀 이하여야 합니다. 크기를 조절해 다시 선택하세요.",
        );
        return;
      }
      photo = selected;
      const crop =
        (Math.min(preview.naturalWidth, preview.naturalHeight) * 224) / 236;
      canvas
        .getContext("2d")
        .drawImage(
          preview,
          (preview.naturalWidth - crop) / 2,
          (preview.naturalHeight - crop) / 2,
          crop,
          crop,
          0,
          0,
          224,
          224,
        );
      byId("preview-wrap").hidden = false;
      byId("picker").classList.add("has-photo");
      byId("choose-label").textContent = "다른 사진 선택";
      announce(
        "사진을 선택했습니다. 중앙 영역을 확인하고 처리 동의 후 테스트하세요.",
      );
      updateControls();
      touch();
    };
    preview.onerror = () => {
      if (current !== generation) return;
      reset();
      error(
        "사진을 읽을 수 없습니다. 다른 JPG, PNG 또는 WebP 사진을 선택하세요.",
      );
    };
    preview.src = objectUrl;
  });

  function validateResult(result) {
    if (
      !result ||
      result.mode !== "experimental_local_photo" ||
      !Array.isArray(result.heads) ||
      result.heads.length !== metadata.targets.length
    )
      throw new Error();
    const keys = new Set();
    for (const head of result.heads) {
      const target = metadata.targets.find((item) => item.key === head.key);
      if (
        !target ||
        keys.has(head.key) ||
        !target.codes.includes(head.predicted_code) ||
        !Array.isArray(head.probabilities) ||
        head.probabilities.length !== target.codes.length
      )
        throw new Error();
      keys.add(head.key);
      const codes = new Set();
      let sum = 0;
      for (const item of head.probabilities) {
        if (
          !target.codes.includes(item.code) ||
          codes.has(item.code) ||
          typeof item.probability !== "number" ||
          !Number.isFinite(item.probability) ||
          item.probability < 0 ||
          item.probability > 1
        )
          throw new Error();
        codes.add(item.code);
        sum += item.probability;
      }
      if (Math.abs(sum - 1) > 0.001) throw new Error();
    }
  }
  function render(result) {
    validateResult(result);
    const cards = document.createDocumentFragment();
    for (const head of result.heads) {
      const target = metadata.targets.find((item) => item.key === head.key);
      const card = document.createElement("article");
      card.className = "head-card";
      const title = document.createElement("h3");
      title.textContent = target.label;
      const predicted = document.createElement("p");
      predicted.className = "prediction";
      const label = document.createElement("span");
      label.textContent = "예측 코드";
      const code = document.createElement("strong");
      code.textContent = head.predicted_code;
      predicted.append(label, code);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "코드별 출력 비중";
      const list = document.createElement("ul");
      list.className = "probabilities";
      for (const item of head.probabilities) {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = item.code;
        const value = document.createElement("span");
        value.textContent = `${(item.probability * 100).toFixed(1)}%`;
        row.append(name, value);
        list.append(row);
      }
      details.append(summary, list);
      card.append(title, predicted, details);
      cards.append(card);
    }
    byId("head-results").replaceChildren(cards);
    byId("result-model").textContent =
      `${metadata.model_run} · ${metadata.checkpoint} · 학습 ${metadata.checkpoint_epoch}회차 모델`;
    byId("results").hidden = false;
    byId("empty").hidden = true;
    announce(
      "8개 항목의 모델 예측이 준비됐습니다. 이 결과는 피부 진단이 아닙니다.",
    );
    byId("result-heading").focus();
  }

  byId("test-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!metadata || !photo || !consent.checked || busy) return;
    error();
    const current = ++generation;
    const request = new AbortController();
    controller?.abort();
    controller = request;
    busy = true;
    byId("results").hidden = true;
    byId("empty").hidden = true;
    byId("loading").hidden = false;
    updateControls();
    touch();
    announce("사진을 이 PC의 모델로 처리하고 있습니다.");
    const timeout = setTimeout(() => request.abort(), 60_000);
    try {
      const response = await fetch("/api/predict", {
        method: "POST",
        body: photo,
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": photo.type,
          "X-Senmiva-Token": metadata.csrf_token,
        },
        signal: request.signal,
      });
      if (current !== generation) return;
      if (!response.ok) {
        if (response.status === 429) throw new Error("busy");
        if ([400, 413, 415, 422].includes(response.status))
          throw new Error("image");
        throw new Error("unavailable");
      }
      const result = await response.json();
      if (current !== generation) return;
      render(result);
    } catch (failure) {
      if (current !== generation) return;
      byId("empty").hidden = false;
      if (failure.name === "AbortError")
        error(
          "처리가 시간 안에 끝나지 않았습니다. 잠시 기다린 뒤 다시 테스트하세요.",
        );
      else if (failure.message === "busy")
        error("다른 사진을 처리하고 있습니다. 잠시 후 다시 테스트하세요.");
      else if (failure.message === "image")
        error(
          "사진을 처리할 수 없습니다. 정지된 JPG, PNG 또는 WebP 파일인지 확인하고 크기를 줄여 다시 선택하세요.",
        );
      else
        error(
          "모델 테스트에 연결할 수 없습니다. 로컬 테스트 프로그램이 실행 중인지 확인하고 다시 시도하세요.",
        );
    } finally {
      clearTimeout(timeout);
      if (current === generation) {
        busy = false;
        controller = null;
        byId("loading").hidden = true;
        updateControls();
        touch();
      }
    }
  });

  consent.addEventListener("change", () => {
    if (!consent.checked && (busy || !byId("results").hidden))
      reset("처리 동의를 해제해 사진과 결과를 비웠습니다.", true);
    updateControls();
    touch();
  });
  clear.addEventListener("click", () =>
    reset("사진과 결과를 비웠습니다.", true),
  );
  for (const event of ["pointerdown", "keydown", "input", "change", "scroll"])
    document.addEventListener(event, touch, { passive: true });
  window.addEventListener("pagehide", () => reset());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) reset("이전 사진과 결과를 비웠습니다.");
  });

  async function connect() {
    try {
      const response = await fetch("/api/model", {
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const info = await response.json();
      if (
        info.mode !== "experimental_local_photo" ||
        !Array.isArray(info.targets) ||
        info.targets.length !== 8 ||
        typeof info.csrf_token !== "string" ||
        !info.csrf_token
      )
        throw new Error();
      metadata = info;
      byId("model-status").textContent =
        `${info.model_run} · 저장된 ${info.checkpoint_epoch}회차 모델 준비 완료`;
      updateControls();
    } catch {
      byId("model-status").textContent =
        "모델에 연결할 수 없습니다. 테스트 프로그램을 다시 실행한 후 이 페이지를 새로고침하세요.";
    }
  }
  connect();
})();
