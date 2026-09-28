// WebGL marble sorter: one instanced glass marble per summary. Each marble's
// whole flight (hopper → Jev gate → rail → bin pile) is computed analytically
// in the vertex shader from its spawn time, so the CPU only writes a few
// attributes when Jev's answer arrives. 100k marbles cost one draw call.
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"
import { ULTRA, ultraCss } from "@/lib/ultrasort"

export type MarbleBin = {
  label: string
  /** OKLCH hue of the category; null draws the neutral "Other" bin */
  hue: number | null
  /** expected share, used to size the pile lattice (any positive scale) */
  weight: number
}

export type MarbleStats = {
  spawned: number
  landed: number
  bins: { landed: number; friction: number }[]
  drained: boolean
  /** live, not-yet-faded simulated drip marbles (informational only) */
  drips: number
}

export type MarbleScene = {
  /** queue one decided summary; released smoothly so polling bursts don't clump */
  push: (bin: number, friction: boolean) => void
  /** lift the gate (armed → running) */
  open: () => void
  /** A baseline marble; with `real`, count a known decision and keep it after Ultrasort.
   * Returns false if the gate is open or no pool slot is available. */
  drip: (bin: number, real?: { friction: boolean }) => boolean
  /** open() plus the violet wave, camera pull-back, and simulated drip marbles fading out */
  ultrasort: () => void
  /** inset: fractions of the canvas height kept clear for overlaid HUD */
  resize: (w: number, h: number, inset?: { top: number; bottom: number }) => void
  stats: () => MarbleStats
  dispose: () => void
}

// ------------------------------------------------------------------ colour

/** OKLCH → linear sRGB, clamped; shader uniforms live in linear space. */
export function oklchLinear(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const cl = (x: number) => Math.min(1, Math.max(0, x))
  return [
    cl(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    cl(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    cl(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ]
}
const binCss = (b: MarbleBin, l = 0.62, c = 0.16) => (b.hue === null ? `oklch(${l + 0.06} 0.01 250)` : `oklch(${l} ${c} ${b.hue})`)
const HEAT_HUE = 45

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ layout

const BIN_W = 1.15
const GATE = { w: 0.96, h: 0.66, d: 0.74 }
const WALL = 0.03
const BIN_Z0 = -0.6
const BIN_Z1 = 0.6
const WALL_H = 0.34
const TROUGH_Z = -0.24
const SLOPE = 0.05
const SPEED = 3.4 // rail speed, units/s
const G = 11 // gravity, units/s²
const T_SLIDE = 0.2 // jar floor → outlet
const T_TUBE = 0.24 // drop down the glass tube into the gate
const T_GATE = 0.12 // through the gate
const T_ROLL = 0.16 // drip: tube foot → its waiting spot on Jev's lid
const T_DROP = 0.14 // drip: waiting spot → into the gate
const QUEUE = 16 // drip waiting spots in a ring around the tube foot
const GHOST = 0.6 // drip fade-out after ultrasort
const WAVE_DELAY = 0.25 // button flood before the wave leaves the jar
const WAVE_T = 0.8 // wave front: jar top → end of the rail
const WAVE_GATE = 0.4 // share of the wave path spent on jar → gate
const PULL_T = 1.2 // camera ease-back
const PULL = 0.14 // extra distance, as a fraction of the framed distance
const CLOSE = 0.56 // drip framing distance, as a fraction of the framed distance

function layout(capacity: number, nBins: number) {
  const r = Math.min(0.045, Math.max(0.0125, 0.0125 * Math.cbrt(100000 / Math.max(1, capacity))))
  const pitch = 1.633 * r // close-packed layer spacing
  // single-file track: rods hug one marble, the tube is barely wider than one
  const track = { gap: 0.15 * r, rodR: 0.4 * r, tubeR: 1.35 * r }
  const trayX0 = -2.35
  const trayX1 = trayX0 + nBins * BIN_W
  const railY0 = 1.0
  const gateX = trayX0 - GATE.w / 2 - 0.12
  const gateY = railY0 + GATE.h / 2 - 0.12
  const gateTop = gateY + GATE.h / 2
  const gateOut = gateX + GATE.w / 2
  // the hopper sits right above Jev and drops straight in through the lid
  const hopper = { x: gateX, z: TROUGH_Z, R: 0.7, bottom: gateTop + 0.62 }
  const outlet = new THREE.Vector3(hopper.x, hopper.bottom - 0.24, hopper.z)
  const gateIn = new THREE.Vector3(gateX, gateTop - 0.1, TROUGH_Z)
  return { r, pitch, track, trayX0, trayX1, gateX, gateY, gateTop, gateIn, gateOut, railY0, hopper, outlet }
}
type Layout = ReturnType<typeof layout>
const railY = (L: Layout, x: number) => L.railY0 - SLOPE * (x - L.gateOut)

/** Close-packed lattice points inside a footprint, one layer. */
function layerPoints(r: number, layer: number, inside: (x: number, z: number) => boolean, x0: number, x1: number, z0: number, z1: number) {
  const pts: [number, number][] = []
  const rowP = Math.sqrt(3) * r
  const ox = layer % 2 ? r : 0
  const oz = layer % 2 ? rowP / 3 : 0
  for (let row = 0, z = z0 + r + oz; z <= z1 - r; row++, z += rowP) {
    for (let x = x0 + r + (row % 2 ? r : 0) + ox; x <= x1 - r; x += 2 * r) if (inside(x, z)) pts.push([x, z])
  }
  return pts
}

/** Jar slots, index order = spawn order: bottom layer first, shuffled within a layer. */
function jarSlots(L: Layout, capacity: number) {
  const { r, pitch, hopper } = L
  const R = hopper.R - r - 0.01
  const disk = (x: number, z: number) => (x - hopper.x) ** 2 + (z - hopper.z) ** 2 <= R * R
  const A = layerPoints(r, 0, disk, hopper.x - R, hopper.x + R, hopper.z - R, hopper.z + R)
  const B = layerPoints(r, 1, disk, hopper.x - R, hopper.x + R, hopper.z - R, hopper.z + R)
  const perLayer = Math.min(A.length, B.length)
  const rand = rng(7)
  const out = new Float32Array(capacity * 3)
  let layer = -1
  let pts: [number, number][] = []
  for (let i = 0; i < capacity; i++) {
    const L2 = Math.floor(i / perLayer)
    if (L2 !== layer) {
      layer = L2
      pts = (layer % 2 ? B : A).slice()
      for (let k = pts.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1))
        ;[pts[k], pts[j]] = [pts[j], pts[k]]
      }
    }
    const [x, z] = pts[i % perLayer]
    out.set([x, hopper.bottom + r + layer * pitch, z], i * 3)
  }
  return { slots: out, perLayer, height: Math.ceil(capacity / perLayer) * pitch }
}

/** Pile slots for one bin, ordered so the pile rises as a mound under the rail. */
function binSlots(L: Layout, bin: number, count: number, seed: number) {
  const { r, pitch, trayX0 } = L
  const x0 = trayX0 + bin * BIN_W + WALL / 2
  const x1 = x0 + BIN_W - WALL
  const cx = (x0 + x1) / 2
  const cz = -0.08
  const rand = rng(seed)
  const all: { p: [number, number, number]; key: number }[] = []
  for (let layer = 0; all.length < count * 1.25 + 64; layer++) {
    for (const [x, z] of layerPoints(r, layer, () => true, x0, x1, BIN_Z0, BIN_Z1)) {
      const d = Math.hypot(x - cx, (z - cz) * 1.2)
      all.push({ p: [x, r + layer * pitch, z], key: layer + (0.3 * d) / (2 * r) + rand() * 1.4 })
    }
  }
  all.sort((a, b) => a.key - b.key)
  return all.slice(0, Math.max(count, 1)).map((s) => s.p)
}

// ------------------------------------------------------------------ shaders

const VERT = /* glsl */ `
attribute vec3 aJar;
attribute vec3 aTarget;
attribute vec4 aRoute; // spawn time (-1 = still in the jar), release x, lane z, colour code
uniform float uTime, uSpawned, uPerLayer, uPitch, uJarBottom, uR;
uniform vec3 uOutlet, uGateIn;
uniform float uGateOut, uRailY0, uSlope, uSpeed, uG, uTSlide, uTTube, uTGate;
uniform float uLid, uQueueR, uDripHold, uTRoll, uTDrop, uGhostAt, uGhostT;
uniform vec3 uColors[8];
uniform vec3 uGlass;
varying vec2 vUv;
varying vec3 vCenter, vColor;
varying float vGlass, vFade;

float railY(float x) { return uRailY0 - uSlope * (x - uGateOut); }

void main() {
  // This conversation left the hopper as a counted drip instance.
  if (aRoute.w >= 2048.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // colour code: bin + 16 when friction was observed; friction is counted, not coloured.
  // Drip marbles add 32 * (waiting spot + 1); counted drips also add 1024.
  bool realDrip = aRoute.w >= 1024.0;
  float code = mod(aRoute.w, 1024.0);
  int bin = int(mod(code, 16.0) + 0.5);
  bool drip = code >= 32.0;
  vec3 jarFloor = vec3(aJar.x, uJarBottom + uR, aJar.z);
  vec3 p;
  float glass = 1.0;
  float t = uTime - aRoute.x;
  float fade = 1.0;
  if (drip) {
    if (!realDrip) fade = 1.0 - clamp((uTime - uGhostAt) / uGhostT, 0.0, 1.0);
    if (aRoute.x < 0.0 || t < 0.0 || fade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  }
  float held = uTTube + uTRoll + uDripHold + uTDrop;
  if (drip && t < held) {
    // outlet → down the tube to the lid → out to its spot in the ring → wait → into the gate
    float a = (floor(code / 32.0) - 1.0) * ${((2 * Math.PI) / QUEUE).toFixed(6)} + 0.4;
    vec3 foot = vec3(uGateIn.x, uLid, uGateIn.z);
    vec3 q = foot + uQueueR * vec3(cos(a), 0.0, sin(a));
    if (t < uTTube) {
      float k = t / uTTube;
      p = mix(uOutlet, foot, k * k);
    } else if (t < uTTube + uTRoll) {
      float k = 1.0 - (t - uTTube) / uTRoll;
      p = mix(foot, q, 1.0 - k * k);
    } else if (t < uTTube + uTRoll + uDripHold) {
      p = q;
    } else {
      float k = (t - uTTube - uTRoll - uDripHold) / uTDrop;
      p = mix(q, uGateIn, k * k);
    }
  } else {
    // past the wait, a drip follows the real path from the gate entrance on
    if (drip) t += uTSlide + uTTube - held;
    if (aRoute.x < 0.0 || t < 0.0) {
      // still in the hopper: the whole pile sinks as marbles leave from the floor
      p = aJar;
      p.y = max(uJarBottom + uR, aJar.y - (uSpawned / uPerLayer) * uPitch);
    } else if (t < uTSlide) {
      float k = t / uTSlide;
      p = mix(jarFloor, uOutlet, k * k);
    } else if (t < uTSlide + uTTube) {
      float k = (t - uTSlide) / uTTube;
      p = mix(uOutlet, uGateIn, k * k);
    } else if (t < uTSlide + uTTube + uTGate) {
      float k = (t - uTSlide - uTTube) / uTGate;
      vec3 outP = vec3(uGateOut, railY(uGateOut) + uR, aRoute.z);
      p = mix(uGateIn, outP, k);
      glass = step(k, 0.5);
    } else {
      glass = 0.0;
      float s = t - uTSlide - uTTube - uTGate;
      float tRail = max(0.0, aRoute.y - uGateOut) / uSpeed;
      if (s < tRail) {
        float x = uGateOut + uSpeed * s;
        p = vec3(x, railY(x) + uR, aRoute.z);
      } else {
        vec3 rel = vec3(aRoute.y, railY(aRoute.y) + uR, aRoute.z);
        float drop = max(0.001, rel.y - aTarget.y);
        float tFall = sqrt(2.0 * drop / uG);
        float f = s - tRail;
        if (f < tFall) {
          float k = f / tFall;
          p = vec3(mix(rel.x, aTarget.x, k), rel.y - 0.5 * uG * f * f, mix(rel.z, aTarget.z, k));
        } else {
          float k = clamp((f - tFall) / 0.14, 0.0, 1.0);
          p = aTarget + vec3(0.0, min(0.035, drop * 0.06) * 4.0 * k * (1.0 - k), 0.0);
        }
      }
    }
  }
  vColor = uColors[bin];
  vGlass = glass;
  vFade = fade;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vCenter = mv.xyz;
  vUv = position.xy * 1.08;
  mv.xy += position.xy * uR * 1.08;
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
uniform mat4 uProj;
uniform float uR;
uniform vec3 uGlass;
varying vec2 vUv;
varying vec3 vCenter, vColor;
varying float vGlass, vFade;

void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  vec3 n = vec3(vUv, sqrt(1.0 - d2));
  vec4 clip = uProj * vec4(vCenter + n * uR, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;

  vec3 L = normalize(vec3(-0.45, 0.75, 0.55));
  vec3 base = mix(vColor, uGlass, vGlass);
  float diff = max(dot(n, L), 0.0);
  // light passing through the glass pools on the far side of the marble
  float caustic = pow(max(dot(n, vec3(-L.xy, L.z)), 0.0), 3.0);
  vec3 col = base * (0.42 + 0.5 * diff) + base * caustic * (0.35 + 0.4 * vGlass);
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  vec3 env = mix(vec3(0.62, 0.58, 0.52), vec3(1.0), smoothstep(-0.3, 0.6, r.y));
  float fres = pow(1.0 - n.z, 3.0);
  col = mix(col, env, fres * (0.35 + 0.4 * vGlass));
  col += vec3(1.0) * pow(max(dot(r, L), 0.0), 48.0) * 1.1;
  col *= 0.72 + 0.28 * smoothstep(-1.0, 0.25, n.y); // contact shading underneath
  float edge = fwidth(d2);
  col = mix(vec3(1.0), col, 0.4 + 0.6 * vFade); // drip ghosts pale as they fade
  gl_FragColor = vec4(col, (1.0 - smoothstep(1.0 - edge * 1.5, 1.0, d2)) * vFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// Ultrasort wave: an emissive violet front that runs jar top → gate → rail end,
// flaring each surface as it passes and decaying after. Patched into the
// standard/physical materials so it costs nothing beyond a few ALU ops.
const WAVE_VERT = /* glsl */ `
varying vec3 vWaveW;
`
const WAVE_FRAG = /* glsl */ `
uniform float uWaveT, uWaveAt, uWaveTop, uWaveMid, uWaveX0, uWaveX1;
uniform vec3 uWaveCol;
varying vec3 vWaveW;
float waveGlow() {
  float s = vWaveW.x < uWaveX0
    ? ${WAVE_GATE.toFixed(2)} * clamp((uWaveTop - vWaveW.y) / (uWaveTop - uWaveMid), 0.0, 1.0)
    : ${WAVE_GATE.toFixed(2)} + ${(1 - WAVE_GATE).toFixed(2)} * clamp((vWaveW.x - uWaveX0) / (uWaveX1 - uWaveX0), 0.0, 1.0);
  float te = uWaveT - uWaveAt - s * ${WAVE_T.toFixed(2)};
  return smoothstep(-0.08, 0.0, te) * exp(-max(te, 0.0) * 2.2);
}
`

// ------------------------------------------------------------------ textures

function woodTexture() {
  const cv = document.createElement("canvas")
  cv.width = 1024
  cv.height = 128
  const c = cv.getContext("2d")!
  c.fillStyle = "#e3c79c"
  c.fillRect(0, 0, cv.width, cv.height)
  const rand = rng(3)
  for (let i = 0; i < 90; i++) {
    const y = rand() * cv.height
    c.strokeStyle = `rgba(${150 + rand() * 40},${100 + rand() * 30},${50 + rand() * 20},${0.08 + rand() * 0.14})`
    c.lineWidth = 0.6 + rand() * 2.4
    c.beginPath()
    c.moveTo(0, y)
    for (let x = 0; x <= cv.width; x += 32) c.lineTo(x, y + Math.sin(x / (80 + rand() * 90) + i) * 3)
    c.stroke()
  }
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

function canvasPlane(w: number, h: number, pxW: number, pxH: number, emissive = false) {
  const cv = document.createElement("canvas")
  cv.width = pxW
  cv.height = pxH
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  const mat = emissive
    ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, transparent: true })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  return { mesh, ctx: cv.getContext("2d")!, tex, cv }
}

// ------------------------------------------------------------------ scene

export function createMarbleScene(
  canvas: HTMLCanvasElement,
  opts: {
    capacity: number
    bins: MarbleBin[]
    armed?: boolean
    reducedMotion?: boolean
    background?: string
    /** conversations each marble stands for; bin labels show landed marbles × this */
    countScale?: number
    /** fractions of the canvas height kept clear for overlaid HUD */
    inset?: { top: number; bottom: number }
    /** extra drip instances; simulated marbles can be recycled, counted ones are kept */
    dripCapacity?: number
    /** seconds each drip marble waits at the gate */
    dripHold?: number
  },
): MarbleScene {
  const { bins, reducedMotion = false, countScale = 1 } = opts
  const toCount = (marbles: number) => Math.round(marbles * countScale)
  const capacity = Math.max(1, Math.floor(opts.capacity))
  const dripCap = Math.max(0, Math.floor(opts.dripCapacity ?? 0))
  const dripHold = Math.max(0, opts.dripHold ?? 1.5)
  const L = layout(capacity, bins.length)
  const { r } = L

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  const bg = new THREE.Color(opts.background ?? "#f6f4f0")
  scene.background = bg
  scene.fog = new THREE.Fog(bg, 16, 34)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTex
  scene.environmentIntensity = 0.55

  const camera = new THREE.PerspectiveCamera(24, 1, 0.02, 80)
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfc2, 0.9))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(-3, 9, 6)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -8
  sun.shadow.camera.right = 8
  sun.shadow.camera.top = 6
  sun.shadow.camera.bottom = -6
  sun.shadow.radius = 6
  sun.shadow.bias = -0.0004
  scene.add(sun)

  const disposables: { dispose: () => void }[] = [renderer, pmrem, envTex]
  const add = <T extends THREE.Mesh>(m: T, shadow = true) => {
    m.castShadow = shadow
    m.receiveShadow = true
    scene.add(m)
    disposables.push(m.geometry)
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    disposables.push(...mats)
    return m
  }
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
    const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), shadow)
    m.position.set(x, y, z)
    return m
  }
  const rod = (a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) => {
    const len = a.distanceTo(b)
    const m = add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 16), mat))
    m.position.copy(a).add(b).multiplyScalar(0.5)
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    return m
  }

  // materials
  const woodTex = woodTexture()
  disposables.push(woodTex)
  const wood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.62 })
  const woodEnd = new THREE.MeshStandardMaterial({ color: 0xd8b98a, roughness: 0.7 })
  const steel = new THREE.MeshStandardMaterial({ color: 0xd6dade, metalness: 1, roughness: 0.22, envMapIntensity: 1.6 })
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a46a, metalness: 1, roughness: 0.3 })
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, envMapIntensity: 2.2, side: THREE.DoubleSide, depthWrite: false })
  const acrylic = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.1, envMapIntensity: 1.8, depthWrite: false })
  const gateMat = new THREE.MeshStandardMaterial({ color: 0x1d2130, roughness: 0.32, metalness: 0.35 })
  disposables.push(wood, woodEnd, steel, brass, glassMat, acrylic, gateMat)

  // violet wave uniforms, shared by every patched material
  const wave = {
    uWaveT: { value: 0 },
    uWaveAt: { value: 1e9 },
    uWaveTop: { value: 0 },
    uWaveMid: { value: L.gateY },
    uWaveX0: { value: L.gateOut },
    uWaveX1: { value: L.trayX1 },
    uWaveCol: { value: new THREE.Vector3(...oklchLinear(ULTRA.l, ULTRA.c, ULTRA.h)) },
  }
  const waveHook = (mat: THREE.Material, strength: number, alphaBoost = 0) => {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, wave)
      sh.vertexShader = WAVE_VERT + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n  vWaveW = (modelMatrix * vec4(transformed, 1.0)).xyz;")
      sh.fragmentShader = WAVE_FRAG + sh.fragmentShader
        .replace("#include <alphamap_fragment>", `#include <alphamap_fragment>\n  float wg = waveGlow();\n  diffuseColor.a = min(1.0, diffuseColor.a + ${alphaBoost.toFixed(2)} * wg);`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n  totalEmissiveRadiance += uWaveCol * (wg * ${strength.toFixed(2)});`)
    }
    mat.customProgramCacheKey = () => `wave:${strength}:${alphaBoost}`
  }
  waveHook(glassMat, 2.4, 0.3)
  waveHook(steel, 1.2)
  waveHook(brass, 1.2)
  waveHook(gateMat, 1.4)

  // table
  const table = add(new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: bg.clone().multiplyScalar(0.985), roughness: 0.95 })), false)
  table.rotation.x = -Math.PI / 2
  table.position.y = -0.07

  // tray: base, back, sides, acrylic front, dividers, label ledge
  const { trayX0, trayX1 } = L
  const trayW = trayX1 - trayX0
  const trayCx = (trayX0 + trayX1) / 2
  box(trayW + 0.1, 0.07, BIN_Z1 - BIN_Z0 + 0.46, wood, trayCx, -0.035, 0.2)
  box(trayW + 0.1, WALL_H + 0.08, 0.05, wood, trayCx, (WALL_H + 0.08) / 2, BIN_Z0 - 0.025)
  box(0.05, WALL_H, BIN_Z1 - BIN_Z0, woodEnd, trayX0 - 0.025, WALL_H / 2, 0)
  box(0.05, WALL_H, BIN_Z1 - BIN_Z0, woodEnd, trayX1 + 0.025, WALL_H / 2, 0)
  box(trayW, WALL_H, 0.012, acrylic, trayCx, WALL_H / 2, BIN_Z1 + 0.006, false)
  for (let i = 1; i < bins.length; i++) box(WALL, WALL_H - 0.02, BIN_Z1 - BIN_Z0, woodEnd, trayX0 + i * BIN_W, (WALL_H - 0.02) / 2, 0)

  // rail: glass floor, twin steel rails, posts down to the dividers, drop pins at each bin
  const railStart = new THREE.Vector3(L.gateOut - 0.02, railY(L, L.gateOut), 0)
  const railEnd = new THREE.Vector3(trayX1 + 0.08, railY(L, trayX1 + 0.08), 0)
  const railLen = railEnd.x - railStart.x
  const { rodR, gap } = L.track
  const rodZ = L.r + gap + rodR
  const rodY = 0.75 * L.r
  const floor = add(new THREE.Mesh(new THREE.BoxGeometry(railLen, 0.006, 2 * (rodZ + rodR)), glassMat), false)
  floor.position.set((railStart.x + railEnd.x) / 2, (railStart.y + railEnd.y) / 2 - 0.004, TROUGH_Z)
  floor.rotation.z = -Math.atan(SLOPE)
  for (const side of [-1, 1]) {
    const z = TROUGH_Z + side * rodZ
    rod(railStart.clone().setZ(z).add(new THREE.Vector3(0, rodY, 0)), railEnd.clone().setZ(z).add(new THREE.Vector3(0, rodY, 0)), rodR, steel)
    for (let i = 0; i <= bins.length; i++) {
      const x = trayX0 + i * BIN_W
      rod(new THREE.Vector3(x, i === 0 || i === bins.length ? WALL_H : WALL_H - 0.02, z), new THREE.Vector3(x, railY(L, x) + rodY, z), 0.6 * rodR, steel)
    }
  }
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.4 })
  disposables.push(pinMat)
  bins.forEach((b, i) => {
    const x = trayX0 + (i + 0.5) * BIN_W
    const col = new THREE.Color().setRGB(...(b.hue === null ? oklchLinear(0.7, 0.01, 250) : oklchLinear(0.62, 0.15, b.hue)), THREE.LinearSRGBColorSpace)
    const tag = new THREE.MeshStandardMaterial({ color: col, roughness: 0.35 })
    disposables.push(tag)
    for (const side of [-1, 1]) {
      const z = TROUGH_Z + side * rodZ
      const pinH = 4 * L.r
      const pin = add(new THREE.Mesh(new THREE.CylinderGeometry(rodR, rodR, pinH, 12), pinMat))
      pin.position.set(x - BIN_W * 0.42, railY(L, x - BIN_W * 0.42) + rodY + pinH / 2, z)
      const cap = add(new THREE.Mesh(new THREE.SphereGeometry(2 * rodR, 16, 12), tag))
      cap.position.set(pin.position.x, pin.position.y + pinH / 2 + rodR, z)
    }
  })

  // hopper: glass cylinder, brass rims, funnel, glass tube to the gate, steel legs
  const jar = jarSlots(L, capacity)
  const hop = L.hopper
  const jarH = Math.max(0.8, jar.height + 0.14)
  wave.uWaveTop.value = hop.bottom + jarH
  const cyl = add(new THREE.Mesh(new THREE.CylinderGeometry(hop.R, hop.R, jarH, 64, 1, true), glassMat), false)
  cyl.position.set(hop.x, hop.bottom + jarH / 2, hop.z)
  for (const y of [hop.bottom, hop.bottom + jarH]) {
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(hop.R + 0.005, 0.018, 12, 64), brass))
    ring.rotation.x = Math.PI / 2
    ring.position.set(hop.x, y, hop.z)
  }
  const disc = add(new THREE.Mesh(new THREE.CircleGeometry(hop.R, 64), new THREE.MeshStandardMaterial({ color: 0xe9e4dc, roughness: 0.5, metalness: 0.2 })), false)
  disc.rotation.x = -Math.PI / 2
  disc.position.set(hop.x, hop.bottom + 0.001, hop.z)
  const funnel = add(new THREE.Mesh(new THREE.CylinderGeometry(hop.R, L.track.tubeR, hop.bottom - L.outlet.y, 64, 1, true), glassMat), false)
  funnel.position.set(hop.x, (hop.bottom + L.outlet.y) / 2, hop.z)
  const gateInP = L.gateIn
  const tube = add(new THREE.Mesh(new THREE.CylinderGeometry(L.track.tubeR, L.track.tubeR, L.outlet.y - L.gateTop, 24, 1, true), glassMat), false)
  tube.position.set(hop.x, (L.outlet.y + L.gateTop) / 2, hop.z)
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.9
    const top = new THREE.Vector3(hop.x + Math.cos(a) * hop.R, hop.bottom, hop.z + Math.sin(a) * hop.R)
    const foot = new THREE.Vector3(hop.x + Math.cos(a) * (hop.R + 0.28), -0.07, hop.z + Math.sin(a) * (hop.R + 0.28))
    rod(top, foot, 0.018, steel)
  }

  // Jev gate: dark body, live front display (text + a strip of recent decisions), amber bar while armed
  const gate = add(new THREE.Mesh(new RoundedBoxGeometry(GATE.w, GATE.h, GATE.d, 5, 0.07), gateMat))
  gate.position.set(L.gateX, L.gateY, TROUGH_Z)
  rod(new THREE.Vector3(L.gateX, -0.07, TROUGH_Z), new THREE.Vector3(L.gateX, L.gateY - GATE.h / 2, TROUGH_Z), 0.04, steel)
  const screen = canvasPlane(GATE.w - 0.12, GATE.h - 0.14, 640, 420, true)
  screen.mesh.position.set(L.gateX, L.gateY, TROUGH_Z + GATE.d / 2 + 0.002)
  scene.add(screen.mesh)
  disposables.push(screen.mesh.geometry, screen.mesh.material as THREE.Material, screen.tex)
  const barMat = new THREE.MeshStandardMaterial({ color: 0xe0a13a, emissive: 0xe0a13a, emissiveIntensity: 0.5, roughness: 0.4 })
  disposables.push(barMat)
  // shutter under the hopper outlet; slides aside when the run starts
  const bar = add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.22), barMat))
  bar.position.set(hop.x, L.outlet.y - 0.03, hop.z)

  // bin labels on the ledge in front of the tray
  const labels = bins.map((b, i) => {
    const plate = canvasPlane(BIN_W - 0.08, 0.3, 460, 120)
    plate.mesh.rotation.x = -Math.PI / 2 + 0.5
    plate.mesh.position.set(trayX0 + (i + 0.5) * BIN_W, 0.06, BIN_Z1 + 0.2)
    scene.add(plate.mesh)
    disposables.push(plate.mesh.geometry, plate.mesh.material as THREE.Material, plate.tex)
    return { ...plate, bin: b, shown: -1 }
  })
  const drawLabel = (i: number, landed: number, friction: number, sim = false) => {
    const lb = labels[i]
    const { ctx, cv } = lb
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.fillStyle = "rgba(255,255,255,0.92)"
    ctx.beginPath()
    ctx.roundRect(4, 4, cv.width - 8, cv.height - 8, 18)
    ctx.fill()
    ctx.fillStyle = binCss(lb.bin)
    ctx.beginPath()
    ctx.arc(30, 38, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#1c1f27"
    ctx.font = "600 26px 'Geist Variable', system-ui, sans-serif"
    ctx.textBaseline = "middle"
    ctx.textAlign = "left"
    ctx.fillText(lb.bin.label, 50, 39, cv.width - 70)
    // the landed count is the live counter during a run: large, squeezed only if it would reach the friction note
    const note = sim ? "simulated" : friction ? `${toCount(friction).toLocaleString("en-US")} friction` : "no friction"
    ctx.font = "500 20px 'Geist Mono Variable', ui-monospace, monospace"
    const noteW = ctx.measureText(note).width
    ctx.font = "700 58px 'Geist Mono Variable', ui-monospace, monospace"
    ctx.fillText(toCount(landed).toLocaleString("en-US"), 20, 86, cv.width - 20 - noteW - 22 - 14)
    ctx.textAlign = "right"
    ctx.font = "500 20px 'Geist Mono Variable', ui-monospace, monospace"
    ctx.fillStyle = friction ? `oklch(0.6 0.16 ${HEAT_HUE})` : "#8a8f99"
    ctx.fillText(note, cv.width - 22, 94)
    lb.tex.needsUpdate = true
  }

  // ---------------------------------------------------------------- marbles
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  // drip marbles live after the real ones in the same buffers: one draw call
  const total = capacity + dripCap
  geo.instanceCount = total
  const jarAll = new Float32Array(total * 3)
  jarAll.set(jar.slots)
  const aJar = new THREE.InstancedBufferAttribute(jarAll, 3)
  const targets = new Float32Array(total * 3)
  const routes = new Float32Array(total * 4)
  for (let i = 0; i < capacity; i++) routes[i * 4] = -1
  for (let i = capacity; i < total; i++) routes.set([-1, 0, 0, 32], i * 4)
  const aTarget = new THREE.InstancedBufferAttribute(targets, 3).setUsage(THREE.DynamicDrawUsage)
  const aRoute = new THREE.InstancedBufferAttribute(routes, 4).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute("aJar", aJar)
  geo.setAttribute("aTarget", aTarget)
  geo.setAttribute("aRoute", aRoute)
  const colors = Array.from({ length: 8 }, (_, i) => {
    const b = bins[i]
    const rgb = !b ? [0.5, 0.5, 0.5] : b.hue === null ? oklchLinear(0.74, 0.012, 250) : oklchLinear(0.64, 0.16, b.hue)
    return new THREE.Vector3(...rgb)
  })
  const uniforms = {
    uTime: { value: 0 },
    uSpawned: { value: 0 },
    uPerLayer: { value: jar.perLayer },
    uPitch: { value: L.pitch },
    uJarBottom: { value: hop.bottom },
    uR: { value: r },
    uOutlet: { value: L.outlet },
    uGateIn: { value: gateInP },
    uGateOut: { value: L.gateOut },
    uRailY0: { value: L.railY0 },
    uSlope: { value: SLOPE },
    uSpeed: { value: SPEED },
    uG: { value: G },
    uTSlide: { value: T_SLIDE },
    uTTube: { value: T_TUBE },
    uTGate: { value: T_GATE },
    uLid: { value: L.gateTop + r },
    uQueueR: { value: Math.min((QUEUE * 2.3 * r) / (2 * Math.PI), GATE.d / 2 - 0.08 - r) },
    uDripHold: { value: dripHold },
    uTRoll: { value: T_ROLL },
    uTDrop: { value: T_DROP },
    uGhostAt: { value: 1e9 },
    uGhostT: { value: GHOST },
    uColors: { value: colors },
    uGlass: { value: new THREE.Vector3(...oklchLinear(0.9, 0.018, 215)) },
    uProj: { value: camera.projectionMatrix },
  }
  const marbleMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, alphaToCoverage: true })
  const marbles = new THREE.Mesh(geo, marbleMat)
  marbles.frustumCulled = false
  scene.add(marbles)
  disposables.push(geo, marbleMat)

  // ---------------------------------------------------------------- bookkeeping
  const totalWeight = bins.reduce((a, b) => a + Math.max(0, b.weight), 0) || 1
  const slots = bins.map((b, i) => binSlots(L, i, Math.ceil(capacity * Math.min(1, (Math.max(0, b.weight) / totalWeight) * 1.5 + 0.04)), 100 + i))
  const used = bins.map(() => 0)
  const landTimes: number[][] = bins.map(() => [])
  const landedIdx = bins.map(() => 0)
  const frictionTimes: number[][] = bins.map(() => [])
  const frictionIdx = bins.map(() => 0)
  const pending: number[] = [] // bin + 16 * friction
  let head = 0
  let spawned = 0
  const rand = rng(99)
  const recent: number[] = [] // for the gate display
  const clock0 = performance.now()
  // Keep reduced motion's already-landed timestamps positive (negative means unspawned).
  const now = () => (performance.now() - clock0) / 1000 + 100
  let openedAt = opts.armed ? Infinity : 0
  let ultraAt = Infinity
  let pullAt = Infinity // camera ease-back start; stays Infinity if skipped

  // drip: a ring buffer of instances plus QUEUE waiting spots on the gate lid
  const dripRand = rng(5)
  const dripPerBin = bins.map(() => 0)
  const dripLandTimes: number[][] = bins.map(() => [])
  const dripLandedIdx = bins.map(() => 0)
  let dripSeq = 0
  let realDripped = 0
  let dripsLive = dripCap > 0
  let held = 0
  const spotFree = new Float64Array(QUEUE) // time each waiting spot is vacated
  const heldFrom = new Float64Array(QUEUE)
  const heldTo = new Float64Array(QUEUE)
  let spotNext = 0

  const release = (t: number, dt: number) => {
    const waiting = pending.length - head
    if (!waiting || openedAt > t) return
    // drain the backlog over ~0.35 s so bursts from polling become a steady stream
    const n = Math.min(waiting, Math.max(1, Math.ceil(waiting * Math.min(1, dt / 0.35))), 6000)
    const start = spawned
    for (let k = 0; k < n; k++) {
      const code = pending[head++]
      if (spawned >= capacity) continue
      const bin = code & 15
      const i = spawned++
      const list = slots[bin]
      let p = list[used[bin]]
      if (!p) {
        // more than the lattice expected: heap on top of the last slot
        const q = list[list.length - 1]
        p = [q[0] + (rand() - 0.5) * BIN_W * 0.6, q[1] + rand() * 0.1, q[2] + (rand() - 0.5) * 0.6]
      }
      used[bin]++
      const bx0 = trayX0 + bin * BIN_W
      const relX = bx0 + BIN_W * (0.1 + rand() * 0.6)
      const lane = TROUGH_Z + (rand() - 0.5) * L.track.gap
      const spawnAt = reducedMotion ? t - 60 : t + (k / n) * dt
      targets.set(p, i * 3)
      routes.set([spawnAt, relX, lane, code], i * 4)
      const drop = railY(L, relX) + r - p[1]
      const land = spawnAt + T_SLIDE + T_TUBE + T_GATE + Math.max(0, relX - L.gateOut) / SPEED + Math.sqrt((2 * Math.max(0.001, drop)) / G)
      landTimes[bin].push(land)
      if (code >= 16) frictionTimes[bin].push(land)
      if (recent.length < 400) recent.push(code)
    }
    const count = spawned - start
    if (count > 0) {
      // three clears ranges after each upload; don't drop a drip range added since
      aTarget.addUpdateRange(start * 3, count * 3)
      aRoute.addUpdateRange(start * 4, count * 4)
      aTarget.needsUpdate = true
      aRoute.needsUpdate = true
    }
    if (head > 50000) {
      pending.splice(0, head)
      head = 0
    }
  }

  const drip = (bin: number, real?: { friction: boolean }) => {
    if (!dripCap || ultraAt !== Infinity || openedAt !== Infinity) return false
    // Counted drips must never be overwritten when the pool wraps.
    if (dripSeq >= dripCap && (real || realDripped > 0)) return false
    if (real && spawned >= capacity) return false
    const t = now()
    bin = Math.max(0, Math.min(bins.length - 1, bin)) & 15
    let spot = spotNext
    for (let k = 0; k < QUEUE; k++) {
      const j = (spotNext + k) % QUEUE
      if (spotFree[j] < spotFree[spot]) spot = j
    }
    spotNext = (spot + 1) % QUEUE
    // wait upstream (hidden) if every spot is taken
    const spawnAt = reducedMotion ? t - 60 : Math.max(t, spotFree[spot] - T_TUBE)
    heldFrom[spot] = spawnAt + T_TUBE + T_ROLL
    heldTo[spot] = heldFrom[spot] + dripHold
    spotFree[spot] = heldTo[spot] + T_DROP
    const list = slots[bin]
    let p: number[]
    if (real) {
      p = list[used[bin]] ?? [list[list.length - 1][0] + (rand() - 0.5) * BIN_W * 0.6, list[list.length - 1][1] + rand() * 0.1, list[list.length - 1][2] + (rand() - 0.5) * 0.6]
      used[bin]++
      realDripped++
      // Consume one hopper marble; the extra drip instance draws it from here on.
      const j = spawned++
      routes.set([t, 0, 0, 2048], j * 4)
      aRoute.addUpdateRange(j * 4, 4)
    } else {
      p = list[dripPerBin[bin]++ % Math.min(list.length, dripCap)]
    }
    const relX = trayX0 + bin * BIN_W + BIN_W * (0.1 + dripRand() * 0.6)
    const lane = TROUGH_Z + (dripRand() - 0.5) * L.track.gap
    const i = capacity + (dripSeq++ % dripCap)
    // same path as a real marble from the gate entrance on
    const fall = Math.sqrt((2 * Math.max(0.001, railY(L, relX) + r - p[1])) / G)
    const land = heldTo[spot] + T_DROP + T_GATE + Math.max(0, relX - L.gateOut) / SPEED + fall
    if (real) {
      landTimes[bin].push(land)
      if (real.friction) frictionTimes[bin].push(land)
    } else {
      dripLandTimes[bin].push(land)
    }
    targets.set(p, i * 3)
    routes.set([spawnAt, relX, lane, bin + 32 * (spot + 1) + (real ? 1024 : 0)], i * 4)
    aTarget.addUpdateRange(i * 3, 3)
    aRoute.addUpdateRange(i * 4, 4)
    aTarget.needsUpdate = true
    aRoute.needsUpdate = true
    return true
  }

  const landedCounts = (t: number) =>
    bins.map((_, i) => {
      const lt = landTimes[i]
      while (landedIdx[i] < lt.length && lt[landedIdx[i]] <= t) landedIdx[i]++
      const ft = frictionTimes[i]
      while (frictionIdx[i] < ft.length && ft[frictionIdx[i]] <= t) frictionIdx[i]++
      return { landed: landedIdx[i], friction: frictionIdx[i] }
    })

  const dripLanded = (t: number) =>
    bins.map((_, i) => {
      const lt = dripLandTimes[i]
      while (dripLandedIdx[i] < lt.length && lt[dripLandedIdx[i]] <= t) dripLandedIdx[i]++
      return dripLandedIdx[i]
    })

  // gate display: a scrolling LED matrix of Jev's latest decisions
  const COLS = 34
  const ROWS = 7
  const leds: (number | null)[] = Array(COLS * ROWS).fill(null)
  let lastScreen = 0
  const drawScreen = (t: number) => {
    const { ctx, cv, tex } = screen
    const armed = openedAt > t
    // held drips blink the amber LEDs; the ultrasort wave flares them violet as it passes the gate
    const blink = held > 0 && Math.sin(t * 9) > 0
    const flareAt = wave.uWaveAt.value + WAVE_GATE * WAVE_T
    const flare = t < flareAt ? 0 : Math.exp(-(t - flareAt) * 2.4)
    // the drip is the simulated GLM baseline: the gate wears its name until the violet wave reaches it
    const glm = dripCap > 0 && (ultraAt === Infinity || (!reducedMotion && t < flareAt))
    ctx.fillStyle = "#12141d"
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.fillStyle = "#ffffff"
    ctx.font = glm ? "700 50px 'Geist Variable', system-ui, sans-serif" : "700 72px 'Geist Variable', system-ui, sans-serif"
    ctx.textAlign = "left"
    ctx.textBaseline = "alphabetic"
    ctx.fillText(glm ? "GLM 5.3 Flash" : "Jev", 28, glm ? 84 : 92, 400)
    ctx.font = "500 20px 'Geist Mono Variable', ui-monospace, monospace"
    ctx.fillStyle = armed || glm ? (held > 0 && !blink ? "#7a5a26" : "#e0a13a") : flare > 0.15 ? ultraCss(0.8) : "#8fe3b0"
    ctx.textAlign = "right"
    ctx.fillText(glm ? "● SORTING" : armed ? "● ARMED" : "● SORTING", cv.width - 26, 58)
    ctx.fillStyle = "#6c7386"
    ctx.fillText(glm ? "simulated" : "TypeSafe", cv.width - 26, 88)
    // shift in new decisions
    const take = Math.min(recent.length, ROWS * 3)
    if (take) {
      const step = Math.max(1, Math.floor(recent.length / take))
      for (let k = 0; k < take; k++) {
        leds.splice((k % ROWS) * COLS, 1)
        leds.splice((k % ROWS) * COLS + COLS - 1, 0, recent[k * step])
      }
      recent.length = 0
    }
    const x0 = 28
    const y0 = 126
    const cell = (cv.width - 56) / COLS
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const code = leds[row * COLS + col]
        let color = "#232838"
        if (armed) {
          const a = 0.15 + 0.35 * Math.max(0, Math.sin(t * 2.2 + col * 0.35 - row * 0.2))
          // bottom row: one solid LED per marble held at the gate
          color = row === ROWS - 1 && col < held ? (blink ? "#f0b44a" : "rgba(224,161,58,0.45)") : `rgba(224,161,58,${blink ? a + 0.12 : a})`
        } else if (code !== null && code !== undefined) color = binCss(bins[code & 15] ?? bins[0], 0.72, 0.17)
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x0 + col * cell + cell / 2, y0 + row * cell + cell / 2, cell * 0.36, 0, Math.PI * 2)
        ctx.fill()
        if (flare > 0.02) {
          ctx.fillStyle = ultraCss(0.62 + 0.2 * flare, flare * (0.55 + 0.45 * Math.max(0, Math.sin(col * 0.6 + row * 0.9 - (t - flareAt) * 14))))
          ctx.fill()
        }
      }
    }
    tex.needsUpdate = true
  }

  // ---------------------------------------------------------------- camera + loop
  // Auto-framed from the machine's projected bounds until the viewer grabs the
  // camera; then OrbitControls owns it (wheel/pinch zooms toward the cursor,
  // drag orbits, right-drag pans) and a double-click hands it back.
  let W = 1
  let H = 1
  const inset = { top: 0.04, bottom: 0.04, ...opts.inset }
  const target = new THREE.Vector3()
  const dir = new THREE.Vector3(-0.22, 0.5, 1).normalize()
  let dist = 12
  const bounds = new THREE.Box3(
    new THREE.Vector3(hop.x - hop.R - 0.35, -0.07, BIN_Z0 - 0.05),
    new THREE.Vector3(trayX1 + 0.1, hop.bottom + jarH + 0.05, BIN_Z1 + 0.4),
  )
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => new THREE.Vector3(k & 1 ? bounds.max.x : bounds.min.x, k & 2 ? bounds.max.y : bounds.min.y, k & 4 ? bounds.max.z : bounds.min.z))
  const place = (sway = 0, pull = 1, at = target) => {
    camera.position.copy(at).addScaledVector(dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), sway), dist * pull)
    camera.lookAt(at)
    camera.updateMatrixWorld()
  }
  const fit = () => {
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    bounds.getCenter(target)
    const yLo = -1 + 2 * inset.bottom
    const yHi = 1 - 2 * inset.top
    const tanV = Math.tan((camera.fov * Math.PI) / 360)
    for (let k = 0; k < 5; k++) {
      place()
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const c of corners) {
        const v = c.clone().project(camera)
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y)
      }
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const half = dist * tanV
      target.addScaledVector(right, ((x0 + x1) / 2) * half * camera.aspect).addScaledVector(up, ((y0 + y1) / 2 - (yLo + yHi) / 2) * half)
      dist *= Math.max((x1 - x0) / 1.9, (y1 - y0) / ((yHi - yLo) * 0.96))
    }
    place()
  }

  // drip view: close enough on the gate and the first piles that single marbles read
  const dripClose = dripCap > 0 && !reducedMotion
  const focus = new THREE.Vector3(L.gateX + 1.5, L.gateY - 0.05, 0)
  const at = new THREE.Vector3()

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.zoomToCursor = true
  controls.screenSpacePanning = true
  controls.minDistance = 0.12
  controls.maxDistance = 40
  controls.maxPolarAngle = Math.PI * 0.49
  let userView = false
  controls.addEventListener("start", () => {
    userView = true
  })
  const resetView = () => {
    userView = false
    fit()
    controls.target.copy(target)
  }
  canvas.addEventListener("dblclick", resetView)
  disposables.push(controls, { dispose: () => canvas.removeEventListener("dblclick", resetView) })

  let raf = 0
  let prev = now()
  let lastLabels = -1
  const frame = () => {
    const t = now()
    const dt = Math.min(0.05, t - prev)
    prev = t
    release(t, dt)
    uniforms.uTime.value = t
    uniforms.uSpawned.value = spawned
    const lift = Math.min(1, Math.max(0, (t - openedAt) / 0.35))
    bar.position.x = hop.x + lift * 0.3
    bar.visible = lift < 1
    barMat.emissiveIntensity = openedAt > t ? 0.35 + 0.3 * Math.sin(t * 3) : 0.5
    wave.uWaveT.value = t
    held = 0
    if (dripsLive) {
      for (let j = 0; j < QUEUE; j++) if (heldFrom[j] <= t && t < heldTo[j]) held++
      // Ghosts gone: stop drawing the pool unless it contains counted replay marbles.
      if (t >= ultraAt + (reducedMotion ? 0 : GHOST)) {
        dripsLive = false
        held = 0
        if (!realDripped) geo.instanceCount = capacity
      }
    }
    if (!userView) {
      const k = Math.min(1, Math.max(0, (t - pullAt) / PULL_T))
      const e = k * k * (3 - 2 * k)
      const sway = reducedMotion ? 0 : Math.sin(t * 0.12) * 0.04
      if (dripClose) {
        at.lerpVectors(focus, target, e)
        place(sway, CLOSE + (1 + PULL - CLOSE) * e, at)
        controls.target.copy(at)
      } else {
        place(sway, 1 + PULL * e)
        controls.target.copy(target)
      }
    }
    controls.update()
    if (t - lastScreen > 0.05) {
      lastScreen = t
      drawScreen(t)
    }
    if (t - lastLabels > 0.08) {
      lastLabels = t
      if (dripCap && ultraAt === Infinity && !realDripped) {
        // before Ultrasort the piles count the simulated drip; after it they count only real marbles
        dripLanded(t).forEach((n, i) => {
          if (labels[i].shown !== -2 - n) {
            labels[i].shown = -2 - n
            drawLabel(i, n, 0, true)
          }
        })
      } else {
        landedCounts(t).forEach((c, i) => {
          if (labels[i].shown !== c.landed + c.friction * 1e7) {
            labels[i].shown = c.landed + c.friction * 1e7
            drawLabel(i, c.landed, c.friction)
          }
        })
      }
    }
    renderer.render(scene, camera)
    raf = requestAnimationFrame(frame)
  }

  const api: MarbleScene = {
    push(bin, friction) {
      pending.push((Math.max(0, Math.min(bins.length - 1, bin)) & 15) + (friction ? 16 : 0))
    },
    open() {
      if (openedAt === Infinity) openedAt = now()
    },
    drip,
    ultrasort() {
      if (ultraAt !== Infinity) return
      const t = now()
      ultraAt = t
      if (openedAt === Infinity) openedAt = t
      uniforms.uGhostAt.value = reducedMotion ? t - GHOST : t
      if (!reducedMotion) {
        wave.uWaveAt.value = t + WAVE_DELAY
        if (!userView) pullAt = t
      }
    },
    resize(w, h, next) {
      if (next) Object.assign(inset, next)
      W = Math.max(1, w)
      H = Math.max(1, h)
      renderer.setSize(W, H, false)
      camera.aspect = W / H
      camera.updateProjectionMatrix()
      if (!userView) fit()
    },
    stats() {
      const t = now()
      const perBin = landedCounts(t)
      const landed = perBin.reduce((a, b) => a + b.landed, 0)
      return { spawned, landed, bins: perBin, drained: pending.length - head === 0 && landed >= spawned, drips: dripsLive ? Math.min(dripSeq, dripCap) - realDripped : 0 }
    },
    dispose() {
      cancelAnimationFrame(raf)
      for (const d of disposables) d.dispose()
    },
  }
  labels.forEach((_, i) => drawLabel(i, 0, 0))
  void document.fonts?.ready.then(() => labels.forEach((lb, i) => ((lb.shown = -1), void i)))
  raf = requestAnimationFrame(frame)
  return api
}
