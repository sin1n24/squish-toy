(() => {
  "use strict";

  const canvas = document.getElementById("glcanvas");
  const dropHint = document.getElementById("dropHint");
  const stage = document.getElementById("stage");
  const fileInput = document.getElementById("fileInput");
  const resetBtn = document.getElementById("resetBtn");
  const undoBtn = document.getElementById("undoBtn");
  const lockBtn = document.getElementById("lockBtn");
  const radiusInput = document.getElementById("radius");
  const shareBtn = document.getElementById("shareBtn");
  const videoBtn = document.getElementById("videoBtn");
  const videoLabel = videoBtn.querySelector("span");
  const lockLabel = document.getElementById("lockLabel");
  const radiusValue = document.getElementById("radiusValue");
  const cropModal = document.getElementById("cropModal");
  const cropStage = document.getElementById("cropStage");
  const cropBox = document.getElementById("cropBox");
  const cropSkipBtn = document.getElementById("cropSkipBtn");
  const cropApplyBtn = document.getElementById("cropApplyBtn");
  const videoModal = document.getElementById("videoModal");
  const videoPreview = document.getElementById("videoPreview");
  const videoShareBtn = document.getElementById("videoShareBtn");
  const videoShareLabel = document.getElementById("videoShareLabel");
  const videoCloseBtn = document.getElementById("videoCloseBtn");
  const toast = document.getElementById("toast");

  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: true })
          || canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });

  if (!gl) {
    stage.innerHTML = '<p style="padding:24px;text-align:center;">お使いのブラウザは WebGL に対応していません。別のブラウザでお試しください。</p>';
    throw new Error("WebGL not supported");
  }

  // ---------- シェーダ ----------
  const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texcoord;
    varying vec2 v_texcoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texcoord = a_texcoord;
    }
  `;
  const fsSource = `
    precision mediump float;
    varying vec2 v_texcoord;
    uniform sampler2D u_texture;
    void main() {
      gl_FragColor = texture2D(u_texture, v_texcoord);
    }
  `;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  gl.useProgram(program);

  const a_position = gl.getAttribLocation(program, "a_position");
  const a_texcoord = gl.getAttribLocation(program, "a_texcoord");
  const u_texture = gl.getUniformLocation(program, "u_texture");

  // ---------- 下地（縁の色を引き延ばして塗る） ----------
  // メッシュの端が内側へ動くと外側が透明（白）になって目立つため、
  // 各画素を「いちばん近い画像の縁」の色で先に塗っておく
  const bgVsSource = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      gl_Position = vec4(a_pos, 0.0, 1.0);
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    }
  `;
  const bgFsSource = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_texture;
    void main() {
      vec2 uv = v_uv;
      float dl = uv.x, dr = 1.0 - uv.x, dt = uv.y, db = 1.0 - uv.y;
      float m = min(min(dl, dr), min(dt, db));
      if (m == dl) uv.x = 0.0;
      else if (m == dr) uv.x = 1.0;
      else if (m == dt) uv.y = 0.0;
      else uv.y = 1.0;
      gl_FragColor = texture2D(u_texture, uv);
    }
  `;
  const bgProgram = gl.createProgram();
  gl.attachShader(bgProgram, compileShader(gl.VERTEX_SHADER, bgVsSource));
  gl.attachShader(bgProgram, compileShader(gl.FRAGMENT_SHADER, bgFsSource));
  gl.linkProgram(bgProgram);
  const bg_a_pos = gl.getAttribLocation(bgProgram, "a_pos");
  const bg_u_texture = gl.getUniformLocation(bgProgram, "u_texture");
  const bgQuadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bgQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

  const positionBuffer = gl.createBuffer();
  const texcoordBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  // v=0 をメッシュの最上段（canvas pixel y=0）に割り当てているため、
  // ここは反転させない（反転させると画像が上下逆になる）
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // ---------- メッシュ ----------
  const GRID = 26; // 分割数（1辺あたりのセル数）
  const ROWLEN = GRID + 1;
  let verts = []; // {u, v, origX, origY, restX, restY, x, y}
  let indexData = null;
  let texcoordData = null;

  function buildMesh(w, h) {
    verts = [];
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const u = i / GRID, v = j / GRID;
        const x = u * w, y = v * h;
        verts.push({ u, v, origX: x, origY: y, restX: x, restY: y, x, y });
      }
    }
    const idx = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * ROWLEN + i, b = a + 1, c = a + ROWLEN, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    indexData = new Uint16Array(idx);
    texcoordData = new Float32Array(verts.length * 2);
    verts.forEach((vtx, i) => {
      texcoordData[i * 2] = vtx.u;
      texcoordData[i * 2 + 1] = vtx.v;
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texcoordData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);
  }

  function uploadPositions() {
    const data = new Float32Array(verts.length * 2);
    const w = canvas.width, h = canvas.height;
    for (let i = 0; i < verts.length; i++) {
      const vtx = verts[i];
      data[i * 2] = (vtx.x / w) * 2 - 1;
      data[i * 2 + 1] = 1 - (vtx.y / h) * 2;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  function render() {
    uploadPositions();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // 下地：縁の色で全面を塗る
    gl.disableVertexAttribArray(a_texcoord);
    gl.useProgram(bgProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, bgQuadBuffer);
    gl.enableVertexAttribArray(bg_a_pos);
    gl.vertexAttribPointer(bg_a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(bg_u_texture, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
    gl.enableVertexAttribArray(a_texcoord);
    gl.vertexAttribPointer(a_texcoord, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u_texture, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_SHORT, 0);
  }

  // ---------- キャンバスサイズ／画像 ----------
  let currentImage = null;

  function fitCanvasToImage(img) {
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const maxW = Math.min(stage.clientWidth - padX, 560);
    const maxH = Math.min(window.innerHeight * 0.55, 560);
    const iw = img.width, ih = img.height;
    let scale = Math.min(maxW / iw, maxH / ih);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.min(scale, 2.2); // 小さい画像を過度に拡大しすぎない
    const dispW = Math.max(64, Math.round(iw * scale));
    const dispH = Math.max(64, Math.round(ih * scale));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = dispW + "px";
    canvas.style.height = dispH + "px";
    // 動画(H.264)は縦横が偶数でないと失敗する環境があるため偶数に揃える
    canvas.width = Math.round((dispW * dpr) / 2) * 2;
    canvas.height = Math.round((dispH * dpr) / 2) * 2;
  }

  function setImage(img) {
    currentImage = img;
    fitCanvasToImage(img);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    buildMesh(canvas.width, canvas.height);
    dropHint.classList.add("hidden");
    history = [];
    updateUndoButton();
    render();
  }

  function loadImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      openCropModal(img);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // ---------- トリミング（画像選択のたび1回だけ） ----------
  let cropState = null; // { pendingImg, displayW, displayH, box:{x,y,w,h} }
  const CROP_MIN = 40;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function updateCropBoxUI() {
    const { box } = cropState;
    cropBox.style.left = box.x + "px";
    cropBox.style.top = box.y + "px";
    cropBox.style.width = box.w + "px";
    cropBox.style.height = box.h + "px";
    cropStage.style.setProperty("--cx", box.x + "px");
    cropStage.style.setProperty("--cy", box.y + "px");
    cropStage.style.setProperty("--cw", box.w + "px");
    cropStage.style.setProperty("--ch", box.h + "px");
  }

  function openCropModal(img) {
    cropStage.querySelectorAll("img.crop-target").forEach((n) => n.remove());
    const el = document.createElement("img");
    el.className = "crop-target";
    el.src = img.src;
    el.alt = "";
    cropStage.insertBefore(el, cropBox);
    cropModal.classList.remove("hidden");

    const setup = () => {
      const displayW = el.clientWidth;
      const displayH = el.clientHeight;
      cropState = {
        pendingImg: img,
        displayW,
        displayH,
        box: { x: 0, y: 0, w: displayW, h: displayH },
      };
      updateCropBoxUI();
    };
    if (el.complete && el.naturalWidth) setup();
    else el.onload = setup;
  }

  function closeCropModal() {
    cropModal.classList.add("hidden");
    cropStage.querySelectorAll("img.crop-target").forEach((n) => n.remove());
    cropState = null;
  }

  function onCropPointerDown(e) {
    if (!cropState) return;
    const handle = e.target.closest(".crop-handle");
    const isBoxBody = e.target === cropBox;
    if (!handle && !isBoxBody) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const startBox = { ...cropState.box };
    const corner = handle ? handle.dataset.corner : null;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const { displayW, displayH } = cropState;
      let { x, y, w, h } = startBox;
      if (corner) {
        if (corner.includes("w")) {
          const nx = clamp(startBox.x + dx, 0, startBox.x + startBox.w - CROP_MIN);
          w = startBox.w - (nx - startBox.x);
          x = nx;
        }
        if (corner.includes("e")) {
          w = clamp(startBox.w + dx, CROP_MIN, displayW - startBox.x);
        }
        if (corner.includes("n")) {
          const ny = clamp(startBox.y + dy, 0, startBox.y + startBox.h - CROP_MIN);
          h = startBox.h - (ny - startBox.y);
          y = ny;
        }
        if (corner.includes("s")) {
          h = clamp(startBox.h + dy, CROP_MIN, displayH - startBox.y);
        }
      } else {
        x = clamp(startBox.x + dx, 0, displayW - startBox.w);
        y = clamp(startBox.y + dy, 0, displayH - startBox.h);
      }
      cropState.box = { x, y, w, h };
      updateCropBoxUI();
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  cropStage.addEventListener("pointerdown", onCropPointerDown);

  cropApplyBtn.addEventListener("click", () => {
    if (!cropState) return;
    const { pendingImg, displayW, box } = cropState;
    const scale = pendingImg.naturalWidth / displayW;
    const sx = box.x * scale;
    const sy = box.y * scale;
    const sw = box.w * scale;
    const sh = box.h * scale;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw));
    c.height = Math.max(1, Math.round(sh));
    const ctx = c.getContext("2d");
    ctx.drawImage(pendingImg, sx, sy, sw, sh, 0, 0, c.width, c.height);
    closeCropModal();
    setImage(c);
  });

  cropSkipBtn.addEventListener("click", () => {
    if (!cropState) return;
    const img = cropState.pendingImg;
    closeCropModal();
    setImage(img);
  });

  // 初期表示用のプレースホルダー顔（オリジナル生成、画像ファイル不要）
  function makePlaceholderFace() {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, "#ffe3c2");
    g.addColorStop(1, "#ffcf9e");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);

    const HAIR = "#3b2820";

    // 後ろ髪（ボブ）
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.ellipse(256, 250, 200, 205, 0, 0, Math.PI * 2);
    ctx.fill();

    // 輪郭
    ctx.fillStyle = "#ffdcb0";
    ctx.beginPath();
    ctx.ellipse(256, 280, 170, 190, 0, 0, Math.PI * 2);
    ctx.fill();

    // 前髪（眉にかからない高さで、毛先をぎざぎざに）
    ctx.fillStyle = HAIR;
    ctx.beginPath();
    ctx.moveTo(80, 250);
    ctx.ellipse(256, 215, 178, 160, 0, Math.PI, Math.PI * 2);
    ctx.lineTo(434, 250);
    ctx.quadraticCurveTo(425, 185, 372, 168);
    ctx.quadraticCurveTo(345, 192, 312, 164);
    ctx.quadraticCurveTo(284, 190, 252, 162);
    ctx.quadraticCurveTo(222, 190, 192, 165);
    ctx.quadraticCurveTo(162, 192, 138, 170);
    ctx.quadraticCurveTo(90, 188, 80, 250);
    ctx.closePath();
    ctx.fill();

    // 髪のつや
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(256, 215, 140, 1.18 * Math.PI, 1.42 * Math.PI);
    ctx.stroke();

    // ほっぺ
    ctx.fillStyle = "#ff9e9e";
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(150, 320, 30, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(362, 320, 30, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 目
    ctx.fillStyle = "#3a2a20";
    ctx.beginPath();
    ctx.ellipse(190, 250, 16, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(322, 250, 16, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(195, 244, 5, 6, 0, 0, Math.PI * 2);
    ctx.ellipse(327, 244, 5, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 眉
    ctx.strokeStyle = "#3a2a20";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(165, 210); ctx.lineTo(215, 200);
    ctx.moveTo(347, 210); ctx.lineTo(297, 200);
    ctx.stroke();

    // 鼻
    ctx.strokeStyle = "#c98a55";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(256, 260); ctx.quadraticCurveTo(240, 300, 256, 312);
    ctx.stroke();

    // 口
    ctx.strokeStyle = "#8a3b2a";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(256, 330, 46, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    return c; // HTMLCanvasElement は texImage2D にそのまま渡せる
  }

  // ---------- 状態管理 ----------
  // resetting: リセット/元に戻すの復元アニメ中 / auto: 動画撮影などの自動デモ再生中
  const STATE = { IDLE: "idle", GRABBING: "grabbing", RELEASING: "releasing", RESETTING: "resetting", AUTO: "auto" };
  let state = STATE.IDLE;
  let lockMode = true; // 初期状態は「固定：オン」

  const grab = { pointerId: null, startX: 0, startY: 0, curX: 0, curY: 0, radius: 100 };
  let radiusFraction = 0.28;

  const RELEASE_MS = 380; // 動画デモで「リセット後の形」へ向かう行きの時間
  const SPRING_MS = 1000;  // 離した/リセット/元に戻す/動画の戻り：ばねで揺れながら戻る時間
  let releaseStart = 0;

  // 減衰振動（ばね）。1回で止まらず、+65%→-41%→+24%→-11% と2〜3回揺れて収まる
  // 末尾の (1 - t^4) で t=1 のとき必ずぴったり目標に一致させる
  function easeSpring(t) {
    if (t >= 1) return 1;
    const DECAY = 2.2;   // 大きいほど早く減衰
    const CYCLES = 2.5;  // 揺れる回数（往復数）
    return 1 - Math.exp(-DECAY * t) * Math.cos(2 * Math.PI * CYCLES * t) * (1 - t * t * t * t);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------- 元に戻す（Undo）履歴 ----------
  const HISTORY_MAX = 20;
  let history = [];

  function updateUndoButton() {
    undoBtn.disabled = history.length === 0;
  }

  function pushHistory() {
    history.push(verts.map((v) => ({ x: v.restX, y: v.restY })));
    if (history.length > HISTORY_MAX) history.shift();
    updateUndoButton();
  }

  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }

  function applyGrabDeform() {
    const dx = grab.curX - grab.startX;
    const dy = grab.curY - grab.startY;
    const r = grab.radius;
    for (const vtx of verts) {
      const ddx = vtx.restX - grab.startX;
      const ddy = vtx.restY - grab.startY;
      const dist = Math.hypot(ddx, ddy);
      const t = dist / r;
      const w = t >= 1 ? 0 : Math.pow(1 - t * t, 2);
      vtx.x = vtx.restX + dx * w;
      vtx.y = vtx.restY + dy * w;
    }
  }

  function bakeToRest() {
    for (const vtx of verts) {
      vtx.restX = vtx.x;
      vtx.restY = vtx.y;
    }
  }

  function startRelease() {
    for (const vtx of verts) {
      vtx.releaseFromX = vtx.x;
      vtx.releaseFromY = vtx.y;
    }
    releaseStart = performance.now();
    state = STATE.RELEASING;
    requestAnimationFrame(tick);
  }

  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  // 各頂点を指定ターゲット（getTarget(vtx, i) -> {x,y}）へ ms かけてアニメーションさせる
  function animateVertsTo(getTarget, ms, ease) {
    return new Promise((resolve) => {
      for (const vtx of verts) {
        vtx.releaseFromX = vtx.x;
        vtx.releaseFromY = vtx.y;
      }
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, Math.max(0, (now - t0) / ms));
        const e = ease(t);
        for (let i = 0; i < verts.length; i++) {
          const vtx = verts[i];
          const target = getTarget(vtx, i);
          vtx.x = lerp(vtx.releaseFromX, target.x, e);
          vtx.y = lerp(vtx.releaseFromY, target.y, e);
        }
        render();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  // 固定でキープした変形も含め、正真正銘の初期形状へアニメーションしながら戻す
  // （「固定」をオフにして手を離した時と同じ、ぷるんと弾む復元アニメーション）
  async function resetMesh() {
    if (state !== STATE.IDLE) return;
    pushHistory();
    state = STATE.RESETTING;
    await animateVertsTo((vtx) => ({ x: vtx.origX, y: vtx.origY }), SPRING_MS, easeSpring);
    for (const vtx of verts) {
      vtx.restX = vtx.origX;
      vtx.restY = vtx.origY;
    }
    state = STATE.IDLE;
  }

  // 直前の「固定」または「リセット」で確定した状態を1つ取り消す
  async function undoLast() {
    if (state !== STATE.IDLE || history.length === 0) return;
    const snapshot = history.pop();
    updateUndoButton();
    state = STATE.RESETTING;
    await animateVertsTo((vtx, i) => snapshot[i], SPRING_MS, easeSpring);
    for (let i = 0; i < verts.length; i++) {
      verts[i].restX = snapshot[i].x;
      verts[i].restY = snapshot[i].y;
    }
    state = STATE.IDLE;
  }

  // 静止区間も毎フレーム描画する（canvas.captureStream は描画が無いとフレームを出さないため）
  function holdFrames(ms) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      function step(now) {
        render();
        if (now - t0 < ms) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  function isDeformed() {
    return verts.some((v) => Math.abs(v.restX - v.origX) > 1 || Math.abs(v.restY - v.origY) > 1);
  }

  // 動画デモ：変顔 →（ばねで）元の顔 →（ばねで）変顔 の1往復。前後に静止区間を入れる
  async function runVideoDemo() {
    await holdFrames(500);
    await animateVertsTo((vtx) => ({ x: vtx.origX, y: vtx.origY }), SPRING_MS, easeSpring);
    await holdFrames(400);
    await animateVertsTo((vtx) => ({ x: vtx.restX, y: vtx.restY }), SPRING_MS, easeSpring);
    await holdFrames(700);
  }

  function tick(now) {
    if (state === STATE.GRABBING) {
      applyGrabDeform();
      render();
      requestAnimationFrame(tick);
    } else if (state === STATE.RELEASING) {
      const t = Math.min(1, Math.max(0, (now - releaseStart) / SPRING_MS));
      const e = easeSpring(t);
      for (const vtx of verts) {
        vtx.x = lerp(vtx.releaseFromX, vtx.restX, e);
        vtx.y = lerp(vtx.releaseFromY, vtx.restY, e);
      }
      render();
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        state = STATE.IDLE;
      }
    }
  }

  // ---------- ポインタ操作 ----------
  function onPointerDown(e) {
    if (state !== STATE.IDLE || grab.pointerId !== null) return;
    if (!currentImage) return;
    grab.pointerId = e.pointerId;
    const p = canvasPointFromEvent(e);
    grab.startX = grab.curX = p.x;
    grab.startY = grab.curY = p.y;
    grab.radius = radiusFraction * Math.min(canvas.width, canvas.height);
    state = STATE.GRABBING;
    canvas.classList.add("grabbing");
    canvas.setPointerCapture(e.pointerId);
    requestAnimationFrame(tick);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (state !== STATE.GRABBING || e.pointerId !== grab.pointerId) return;
    const p = canvasPointFromEvent(e);
    grab.curX = p.x;
    grab.curY = p.y;
    e.preventDefault();
  }

  function endGrab() {
    if (state !== STATE.GRABBING) return;
    canvas.classList.remove("grabbing");
    grab.pointerId = null;
    if (lockMode) {
      pushHistory();
      bakeToRest();
      state = STATE.IDLE;
      render();
    } else {
      startRelease();
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== grab.pointerId) return;
    endGrab();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // ---------- UI ----------
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadImageFile(f);
  });

  stage.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropHint.classList.remove("hidden");
  });
  stage.addEventListener("dragleave", () => {
    dropHint.classList.add("hidden");
  });
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    dropHint.classList.add("hidden");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });

  resetBtn.addEventListener("click", resetMesh);
  undoBtn.addEventListener("click", undoLast);

  lockBtn.addEventListener("click", () => {
    lockMode = !lockMode;
    lockBtn.setAttribute("aria-pressed", String(lockMode));
    lockLabel.textContent = lockMode ? "固定 ON" : "固定 OFF";
  });

  function updateRadiusUI() {
    const min = Number(radiusInput.min), max = Number(radiusInput.max);
    const pct = ((Number(radiusInput.value) - min) / (max - min)) * 100;
    radiusInput.style.setProperty("--pct", pct + "%");
    radiusValue.textContent = radiusInput.value;
  }

  radiusInput.addEventListener("input", () => {
    radiusFraction = Number(radiusInput.value) / 100;
    updateRadiusUI();
  });
  updateRadiusUI();

  window.addEventListener("resize", () => {
    if (!currentImage) return;
    fitCanvasToImage(currentImage);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, currentImage);
    buildMesh(canvas.width, canvas.height);
    state = STATE.IDLE;
    render();
  });

  // ---------- 書き出し／シェア ----------
  function canvasToBlobSync(cv) {
    const dataUrl = cv.toDataURL("image/png");
    const parts = dataUrl.split(",");
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const SITE_URL = "https://sin1.studio/squish-toy/";
  const SHARE_TEXT = "変顔クリエーターで変顔を作ってみた！ " + SITE_URL;

  // ---------- 通知（alertの代わり） ----------
  let toastTimer = null;
  function showToast(msg, ms = 2800) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
  }

  // シェアに失敗(非対応・拒否)したら保存に切り替える。ユーザーが閉じた(AbortError)場合は何もしない
  async function shareOrSave(file, blob) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: SHARE_TEXT, url: SITE_URL });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    triggerDownload(blob, file.name);
    showToast("保存しました。お好きなアプリで共有してください。");
  }

  shareBtn.addEventListener("click", () => {
    render();
    const blob = canvasToBlobSync(canvas);
    shareOrSave(new File([blob], "hengao.png", { type: "image/png" }), blob);
  });

  // ---------- 動画でシェア ----------
  // 撮影(約3.5秒)の後に navigator.share を呼ぶと、タップ直後の扱いが切れて iOS Safari 等で拒否される。
  // そのため撮影後はプレビューを出し、そこでのタップで共有/保存する
  let mediaRecording = false;
  let videoFile = null;
  let videoUrl = null;

  function pickVideoMime() {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  }

  function closeVideoModal() {
    videoModal.classList.add("hidden");
    videoPreview.pause();
    videoPreview.removeAttribute("src");
    videoPreview.load();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = null;
    videoFile = null;
  }

  function openVideoModal(file) {
    videoFile = file;
    videoUrl = URL.createObjectURL(file);
    videoPreview.src = videoUrl;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    videoShareLabel.textContent = canShare ? "シェア" : "保存";
    videoModal.classList.remove("hidden");
    videoPreview.play().catch(() => {});
  }

  async function recordVideo() {
    if (!currentImage || state !== STATE.IDLE || mediaRecording) return;
    if (!canvas.captureStream || typeof MediaRecorder === "undefined") {
      showToast("お使いのブラウザは動画の書き出しに対応していません。");
      return;
    }
    if (!isDeformed()) {
      showToast("まず顔をつまんで変顔にしてから押してね（固定ONで離すとキープ）");
      return;
    }

    const mimeType = pickVideoMime();
    const stream = canvas.captureStream(30);
    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 6_000_000,
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      showToast("動画の作成に失敗しました。");
      return;
    }

    mediaRecording = true;
    state = STATE.AUTO;
    videoBtn.disabled = true;
    const originalLabel = videoLabel.textContent;
    videoLabel.textContent = "撮影中…";

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));

    try {
      recorder.start();
      await runVideoDemo();
      recorder.stop();
      await stopped;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      mediaRecording = false;
      state = STATE.IDLE;
      videoBtn.disabled = false;
      videoLabel.textContent = originalLabel;
    }

    const type = (recorder.mimeType || mimeType || "video/webm").split(";")[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) {
      showToast("動画の作成に失敗しました。");
      return;
    }
    const ext = type.includes("mp4") ? "mp4" : "webm";
    openVideoModal(new File([blob], "hengao." + ext, { type }));
  }

  videoBtn.addEventListener("click", recordVideo);
  videoShareBtn.addEventListener("click", () => {
    if (videoFile) shareOrSave(videoFile, videoFile);
  });
  videoCloseBtn.addEventListener("click", closeVideoModal);

  // ---------- 関連商品（12個からランダムで4つ表示） ----------
  const AMAZON_TAG = "sin1n24-22";
  const PRODUCTS = [
    ["B07W6YXFRJ", "CINECE 福笑い お正月遊びセット おかめとひょっとこ柄（２枚1セット）", "71ACQvh3ArL"],
    ["B0DZ5GST4J", "Amazonベーシック スマホ用三脚 自撮り棒 スマホスタンド リモコン付属 高さ調節可能 最大91.4cm 360度回転雲台", "51ny8fkdLzL"],
    ["B0BBG2R1YK", "キヤノン iNSPiC PV-223-WH スマホ専用ミニフォトプリンター ホワイト", "511AsGBCRaL"],
    ["B09V897K6V", "スクイーズ玩具 30個セット ストレス解消グッズ 低反発 もちもち", "71zMUmPbyuL"],
    ["B075ZS5JJX", "メガネおもちゃ 口ひげ 鼻付き ピエロ パーティー 仮装 いたずら 面白い 余興", "61Cjr8HeGmL"],
    ["B0CKZ5CKPP", "210°魚眼レンズ フィッシュアイ スマホ用カメラレンズ クリップ式 自撮りレンズ", "619FI2s8pNL"],
    ["B0G5P496HD", "富士フイルム(FUJIFILM) チェキ インスタントカメラ instax mini 13 クレイホワイト", "61oQ9PMvJ6L"],
    ["B07D2DVX6D", "富士フイルム instax チェキ用フィルム INSTAX MINI JP 1 10枚入", "61r0WTpGq2L"],
    ["404896996X", "1週間後には「マイナス7歳」見ちがえる! 間々田佳子のかんたん顔筋トレ", "51WakAX10TS"],
    ["B00L6DAD52", "赤ちゃんマスク 大人用 ガキ使 笑ってはいけない 仮装 変装 被り物 リアル赤ちゃん 泣き顔マスク", "51FzxEZQbcL"],
    ["B0BHHQSZST", "オンダ(Onda) 玩具 ポップチューブ やみつきチューブ ストレス発散 伸びる ストロー", "71SCgZCYffL"],
    ["B099RMXNFN", "ポスター A3サイズ 絵画 (日本製) 日本画 名画 東洲斎写楽 三代目大谷鬼次の奴江戸兵衛", "712DKEfVn5L"],
  ];
  const RELATED_COUNT = 4;

  function renderRelatedProducts() {
    const grid = document.getElementById("relatedGrid");
    if (!grid) return;
    const pool = PRODUCTS.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    grid.innerHTML = "";
    for (const [asin, title, img] of pool.slice(0, RELATED_COUNT)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "product-card";
      a.href = "https://www.amazon.co.jp/dp/" + asin + "/?tag=" + AMAZON_TAG;
      a.target = "_blank";
      a.rel = "noopener noreferrer sponsored";
      const im = document.createElement("img");
      im.className = "product-card-image";
      im.src = "https://m.media-amazon.com/images/I/" + img + "._AC_SX679_.jpg";
      im.alt = "";
      im.loading = "lazy";
      im.decoding = "async";
      const span = document.createElement("span");
      span.className = "product-card-title";
      span.textContent = title;
      a.append(im, span);
      li.append(a);
      grid.append(li);
    }
  }
  renderRelatedProducts();

  // ---------- 初期化 ----------
  setImage(makePlaceholderFace());
})();
