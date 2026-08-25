(() => {
  "use strict";

  const canvas = document.getElementById("glcanvas");
  const dropHint = document.getElementById("dropHint");
  const stage = document.getElementById("stage");
  const fileInput = document.getElementById("fileInput");
  const resetBtn = document.getElementById("resetBtn");
  const lockBtn = document.getElementById("lockBtn");
  const radiusInput = document.getElementById("radius");
  const downloadBtn = document.getElementById("downloadBtn");
  const shareBtn = document.getElementById("shareBtn");

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

  const positionBuffer = gl.createBuffer();
  const texcoordBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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
    const maxW = Math.min(stage.clientWidth - 28, 560);
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
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
  }

  function setImage(img) {
    currentImage = img;
    fitCanvasToImage(img);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    buildMesh(canvas.width, canvas.height);
    dropHint.classList.add("hidden");
    render();
  }

  function loadImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(img);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

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

    // 輪郭
    ctx.fillStyle = "#ffdcb0";
    ctx.beginPath();
    ctx.ellipse(256, 280, 170, 190, 0, 0, Math.PI * 2);
    ctx.fill();

    // 耳
    ctx.beginPath();
    ctx.ellipse(96, 260, 34, 44, 0, 0, Math.PI * 2);
    ctx.ellipse(416, 260, 34, 44, 0, 0, Math.PI * 2);
    ctx.fill();

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
  const STATE = { IDLE: "idle", GRABBING: "grabbing", RELEASING: "releasing" };
  let state = STATE.IDLE;
  let lockMode = false;
  let tempLock = false; // PC: R キー押しっぱなし

  const grab = { pointerId: null, startX: 0, startY: 0, curX: 0, curY: 0, radius: 100 };
  let radiusFraction = 0.28;

  const RELEASE_MS = 380;
  let releaseStart = 0;

  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    const x = t - 1;
    return 1 + c3 * x * x * x + c1 * x * x;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

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

  function resetMesh() {
    for (const vtx of verts) {
      vtx.restX = vtx.origX;
      vtx.restY = vtx.origY;
      vtx.x = vtx.origX;
      vtx.y = vtx.origY;
    }
    state = STATE.IDLE;
    render();
  }

  function tick(now) {
    if (state === STATE.GRABBING) {
      applyGrabDeform();
      render();
      requestAnimationFrame(tick);
    } else if (state === STATE.RELEASING) {
      const t = Math.min(1, (now - releaseStart) / RELEASE_MS);
      const e = easeOutBack(t);
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
    if (lockMode || tempLock) {
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

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") tempLock = true;
    if (e.key === "Escape") resetMesh();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "r" || e.key === "R") tempLock = false;
  });

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

  lockBtn.addEventListener("click", () => {
    lockMode = !lockMode;
    lockBtn.setAttribute("aria-pressed", String(lockMode));
    lockBtn.textContent = lockMode ? "🔒 固定：オン" : "🔓 固定：オフ";
  });

  radiusInput.addEventListener("input", () => {
    radiusFraction = Number(radiusInput.value) / 100;
  });

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

  const SHARE_TEXT = "顔スクイッシュトイで変顔を作ってみた！";

  downloadBtn.addEventListener("click", () => {
    render();
    const blob = canvasToBlobSync(canvas);
    triggerDownload(blob, "squish-face.png");
  });

  shareBtn.addEventListener("click", () => {
    render();
    const blob = canvasToBlobSync(canvas);
    const file = new File([blob], "squish-face.png", { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text: SHARE_TEXT }).catch(() => {});
      return;
    }

    triggerDownload(blob, "squish-face.png");
    window.open(
      "https://twitter.com/intent/tweet?text=" + encodeURIComponent(SHARE_TEXT),
      "_blank",
      "noopener"
    );
    window.setTimeout(() => {
      alert("画像を保存しました。Xの投稿画面が開くので、保存した画像を手動で添付してください。");
    }, 300);
  });

  // ---------- 初期化 ----------
  setImage(makePlaceholderFace());
})();
