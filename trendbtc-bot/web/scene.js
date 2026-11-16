// 3D background: spinning neon Bitcoin coin, orbiting asset crystals,
// particle nebula and a scrolling synthwave grid, with bloom.
// Reacts to live data sent by app.js via the "neon:state" event.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const canvas = document.getElementById("scene3d");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (e) {
  console.warn("WebGL tidak tersedia, latar 3D dimatikan.", e);
}

if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05010f, 0.035);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0.6, 9);

  // ---------- lights ----------
  scene.add(new THREE.AmbientLight(0x6040a0, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(4, 6, 6);
  scene.add(keyLight);
  const cyanLight = new THREE.PointLight(0x22e5ff, 40, 30);
  cyanLight.position.set(-5, 2, 4);
  scene.add(cyanLight);
  const magentaLight = new THREE.PointLight(0xff3df2, 40, 30);
  magentaLight.position.set(5, -2, 3);
  scene.add(magentaLight);

  // ---------- coin ----------
  function makeFaceTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(200, 180, 40, 256, 256, 260);
    grad.addColorStop(0, "#ffe7a3");
    grad.addColorStop(0.45, "#f7a531");
    grad.addColorStop(1, "#a85a00");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = "rgba(90,40,0,0.55)";
    g.lineWidth = 14;
    g.beginPath(); g.arc(256, 256, 214, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      g.beginPath();
      g.moveTo(256 + Math.cos(a) * 226, 256 + Math.sin(a) * 226);
      g.lineTo(256 + Math.cos(a) * 240, 256 + Math.sin(a) * 240);
      g.stroke();
    }
    g.font = "bold 300px Arial, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(80,30,0,0.45)";
    g.fillText("₿", 262, 274);
    g.fillStyle = "#fff4d6";
    g.fillText("₿", 252, 262);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  const coinGroup = new THREE.Group();
  scene.add(coinGroup);

  const faceTex = makeFaceTexture();
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf7931a, metalness: 1, roughness: 0.28, emissive: 0x3a1800, emissiveIntensity: 0.6 });
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.75, roughness: 0.32, emissive: 0xf7931a, emissiveMap: faceTex, emissiveIntensity: 0.25 });
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.24, 96, 1), [edgeMat, faceMat, faceMat]);
  coin.rotation.x = Math.PI / 2;
  coinGroup.add(coin);

  const rimMat = new THREE.MeshBasicMaterial({ color: 0x22e5ff });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.74, 0.035, 16, 160), rimMat);
  coinGroup.add(rim);

  // orbit rings
  const rings = [];
  const ringDefs = [
    { r: 2.6, color: 0xff3df2, tilt: [1.2, 0.2, 0] },
    { r: 3.1, color: 0x22e5ff, tilt: [1.4, -0.5, 0.3] },
    { r: 3.6, color: 0x5d8bff, tilt: [1.0, 0.7, -0.2] },
  ];
  for (const d of ringDefs) {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(d.r, 0.012, 8, 220),
      new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.85 })
    );
    m.rotation.set(...d.tilt);
    coinGroup.add(m);
    rings.push(m);
  }

  // ---------- asset crystals (one per asset, colored by direction) ----------
  const crystals = [];
  const crystalGeo = new THREE.OctahedronGeometry(0.18, 0);
  const crystalEdges = new THREE.EdgesGeometry(crystalGeo);
  for (let i = 0; i < 12; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x22e5ff, emissive: 0x22e5ff, emissiveIntensity: 1.2, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(crystalGeo, mat);
    const edges = new THREE.LineSegments(crystalEdges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    mesh.add(edges);
    mesh.userData = { angle: (i / 12) * Math.PI * 2, radius: 3.1, speed: 0.18 + (i % 3) * 0.03, bob: Math.random() * Math.PI * 2 };
    coinGroup.add(mesh);
    crystals.push(mesh);
  }

  // ---------- particles ----------
  const PCOUNT = reduceMotion ? 1200 : 2600;
  const pGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(PCOUNT * 3);
  const col = new Float32Array(PCOUNT * 3);
  const cA = new THREE.Color(0x22e5ff), cB = new THREE.Color(0xff3df2), tmp = new THREE.Color();
  for (let i = 0; i < PCOUNT; i++) {
    const r = 6 + Math.random() * 30;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 8;
    tmp.copy(cA).lerp(cB, Math.random());
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(particles);

  // ---------- synthwave grid floor ----------
  const grid = new THREE.GridHelper(120, 120, 0xff3df2, 0x22e5ff);
  grid.material.transparent = true;
  grid.material.opacity = 0.2;
  grid.position.y = -3.8;
  scene.add(grid);

  // ---------- post processing ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.55, 0.18);
  composer.addPass(bloom);

  // ---------- layout & input ----------
  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const wide = w > 1000;
    coinGroup.position.set(wide ? 3.0 : 0, wide ? 0.2 : 1.6, 0);
    coinGroup.scale.setScalar(wide ? 1 : 0.72);
  }
  window.addEventListener("resize", layout);
  layout();

  const mouse = { x: 0, y: 0 };
  window.addEventListener("pointermove", (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // ---------- live data hooks ----------
  const GREEN = new THREE.Color(0x39ff88), RED = new THREE.Color(0xff4d6d), CYAN = new THREE.Color(0x22e5ff), YELLOW = new THREE.Color(0xffe14d);
  const rimTarget = CYAN.clone();
  let spinBoost = 0;
  let lastBtc = 0;

  window.addEventListener("neon:state", (ev) => {
    const s = ev.detail;
    if (!s) return;
    const btc = s.prices?.BTC || 0;
    const st = s.markets?.BTC?.["1m"]?.start || 0;
    if (btc > 0 && st > 0) rimTarget.copy(btc > st ? GREEN : btc < st ? RED : YELLOW);
    if (lastBtc > 0 && btc > 0 && Math.abs(btc - lastBtc) > 0) spinBoost = Math.min(spinBoost + Math.abs(btc - lastBtc) / 15, 3);
    lastBtc = btc;
    (s.assets || []).forEach((a, i) => {
      const c = crystals[i];
      if (!c) return;
      const p = s.prices?.[a] || 0;
      const tf = (s.timeframes?.[a] || ["5m"]).includes("5m") ? "5m" : s.timeframes[a][0];
      const start = s.markets?.[a]?.[tf]?.start || 0;
      const target = p > 0 && start > 0 ? (p > start ? GREEN : p < start ? RED : YELLOW) : CYAN;
      c.material.color.copy(target);
      c.material.emissive.copy(target);
    });
    if (s.paused) rimTarget.copy(YELLOW);
  });

  // ---------- animate ----------
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    const motion = reduceMotion ? 0.25 : 1;

    coin.rotation.z += dt * (0.6 + spinBoost) * motion;
    spinBoost *= 0.96;
    coinGroup.rotation.x = Math.sin(t * 0.5) * 0.12 + mouse.y * 0.15;
    coinGroup.rotation.y = mouse.x * 0.35;
    coinGroup.position.y += (Math.sin(t * 1.2) * 0.002) * motion;

    rimMat.color.lerp(rimTarget, 0.05);
    rings.forEach((r, i) => { r.rotation.z += dt * (0.12 + i * 0.07) * (i % 2 ? -1 : 1) * motion; });

    crystals.forEach((c) => {
      const u = c.userData;
      u.angle += dt * u.speed * motion;
      c.position.set(Math.cos(u.angle) * u.radius, Math.sin(t * 1.5 + u.bob) * 0.35, Math.sin(u.angle) * u.radius);
      c.rotation.x += dt * 1.2 * motion;
      c.rotation.y += dt * 0.8 * motion;
    });

    particles.rotation.y += dt * 0.015 * motion;
    grid.position.z = (t * 1.2 * motion) % 1;

    const scroll = window.scrollY / Math.max(window.innerHeight, 1);
    camera.position.x += (mouse.x * 0.6 - camera.position.x) * 0.04;
    camera.position.y += (0.6 - scroll * 1.6 - mouse.y * 0.4 - camera.position.y) * 0.06;
    camera.lookAt(0, -scroll * 1.2, 0);

    composer.render();
    requestAnimationFrame(tick);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) clock.getDelta(); });
  tick();
}
