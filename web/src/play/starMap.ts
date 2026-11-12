// The star map, as the client's map view draws the universe (eve/client/script/ui/shared/mapView/mapView.py):
// - each known-space system (mapViewData.GetKnownUniverseSolarSystems: idCheckers.IsKnownSpaceSystem, 30000000 to
//   30999999) a star at its map position, WorldPosToMapPos(center) = (x, y, z) x (-1, -1, 1) x UNIVERSE_SCALE
//   (mapViewUtil.py), here with EVE's z mirrored into three's;
// - the stars a Tr2RuntimeInstanceData of a unit plane (res:/Graphics/Generic/UnitPlane/UnitPlane.gr2, +-0.5) drawn by
//   StarmapNew.fx's first pass (its sm_hi record disassembled, client 3396210): the position morphed between its two
//   (StarmapMorphValue, here the one layout: 0), in view space pushed by the plane's corner times
//   0.2274 x (sin(fov / 2) x (d^2 + 1))^0.185 x min(sqrt(d^2 + 1) x 0.003333, 1) x 25 (d^2 the view-space length
//   squared, its w 1 counted); the colour the star's, its alpha clamp(range.x / d, 0.1, 1) x max(1 - d / (range.y -
//   range.x), 0.25) where distanceRange is (camera distance, max(100, 4 x camera distance)) (_UpdateDistanceRangeValues);
//   the pixel TexMap (mapStarNew5.dds) x that;
// - and its second pass, the bubbles: the same position, in view space pushed by the corner x d x
//   cameraDistanceScalingFactor (1 / SIZE_FACTOR_VALUE 5000) x the star's size (CUSTOM0: the filter's GetStarSize,
//   BaseMapFilterScalar: STAR_SIZE_AFFECTED 60 x the entry's size factor STAR_SIZE_FACTOR_STANDARD 0.5 for a system
//   with a faction, STAR_SIZE_UNIMPORTANT 8 for one without) x SizeControls.x (BUBBLE_BASE_SIZE_MULTIPLIER 1);
//   colour the star's (CUSTOM1) x clamp(range.x / d, 0.8, 1); the pixel, in sprite mode 0 (the filter's SpriteValues:
//   MARKER_NONE, its sprite texture, no static size, mode 0), HeatTexture (the filter's spriteEffectPath,
//   mapStarNewHeat.dds) x that colour (mode 1, an icon-atlas shape over TexBackgroundColor, no filter here uses);
// - the default colour mode, STARMODE_FACTIONEMPIRE (mapViewConst VIEWMODE_COLOR_DEFAULT; filters/
//   mapFilterFactionEmpire.py): a system with an NPC faction its faction's colour (filter_utils.GetBase11ColorByID:
//   fwwarzone's FACTION_ID_TO_COLOR, else BASE11_COLORRANGE[factionID % 11]), any other NEUTRAL_COLOR;
// - the jump lines between systems a stargate joins (CreateJumpLineSet: an EveCurveLineSet, mapViewUtil.CreateLineSet's
//   TexMap lineSegment.dds and OverlayTexMap lineSegmentConstellation.dds; LoadJumpLines: AddStraightLine each), as
//   UpdateLineColorAndWidth makes them in the 3D layout: LINE_COLOR (0.5 grey) at the LineOpacityFinder3D's default
//   opacity (0.2, every line shown), a region jump's colour SetBrightness(0.9) (grey) and width JUMPLINE_BASE_WIDTH
//   x 1.6 with ticks (ChangeLineAnimation((0, 0, 0, 1), 0, length / REGION_LINE_TICKSIZE)), a constellation jump's
//   width x 1.3 with ticks (CONSTELLATION_LINE_TICKSIZE), any other JUMPLINE_BASE_WIDTH 3 and no overlay;
//   Tr2CurveLineSet::WriteLineVerticesToBuffer's six vertices a line (position, lineDir = the way to the other end and
//   the signed width, beginEnd = (0 | 1, 0 | 1, multiColorBorder -1, 1), animation (speed, scale), colour, override
//   colour, overlay colour) through Lines3DStarMapNew.fx (its sm_hi record disassembled): a screen-space quad |width|
//   pixels wide (TargetResolution), its ends pushed out by half that; TexMap across it and along its caps (0-0.5 over
//   the start cap, 0.5 along, 0.5-1 over the end cap); OverlayTexMap at (across, (speed x Time + along) x scale) adds
//   its rgb x the overlay colour's and takes its alpha by the overlay's alpha; the colour faded by distanceRange (x 100
//   at the far end) as the stars are; alpha-blended (the line set's transparent batch), no culling;
// - the map camera (camera/mapCamera.py): fov 1.0 rad, orbiting the current system.
// Not yet: the abstract layout, markers and labels, the selected / hovered lines' opacity, the route.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadDds } from "../three/ddsTexture.ts";
import { logDepth } from "../three/logDepth.ts";

/** mapViewConst.py */
const UNIVERSE_SCALE = 1.5e-13;
const MIN_CAMERA_DISTANCE = 1.0;
const MAX_CAMERA_DISTANCE = 160000.0;
/** mapView.py ZOOM_DIST_SYSTEM: the distance the map opens at on a system. */
const ZOOM_DIST_SYSTEM = 6000;
/** mapFilterConst.py NEUTRAL_COLOR, BASE11_COLORRANGE; eveColor.py's faction colours (#AARRGGBB, or #RRGGBB). */
const NEUTRAL: [number, number, number] = [0.5, 0.5, 0.5];
const BASE11: [number, number, number][] = [
  [0.0, 0.40784313725490196, 0.21568627450980393], [0.10196078431372549, 0.596078431372549, 0.3137254901960784],
  [0.4, 0.7411764705882353, 0.38823529411764707], [1.0, 0.20000000000000007, 0.3842424242424244],
  [0.6509803921568628, 0.8509803921568627, 0.41568627450980394], [0.9, 0.3876136363636364, 0.36000000000000004],
  [0.8509803921568627, 0.9372549019607843, 0.5450980392156862], [0.9568627450980393, 0.42745098039215684, 0.2627450980392157],
  [0.9921568627450981, 0.6823529411764706, 0.3803921568627451], [0.996078431372549, 0.8784313725490196, 0.5450980392156862],
  [1.0, 1.0, 0.7490196078431373],
];
const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
/** fwwarzone/client/dashboard/const.py FACTION_ID_TO_COLOR (appConst faction IDs). */
const FACTION_COLOR: Record<number, [number, number, number]> = {
  500001: rgb("00ACD1"), // Caldari State, CALDARI_BLUE
  500004: rgb("40AA5E"), // Gallente Federation, GALLENTE_GREEN
  500002: rgb("FE3743"), // Minmatar Republic, MINMATAR_RED
  500003: rgb("E7B815"), // Amarr Empire, AMARR_GOLD
  500011: rgb("FFE1B0"), // Angel Cartel, ANGEL_COLOR
  500010: rgb("E54500"), // Guristas Pirates, GURISTAS_COLOR
  500006: rgb("D3D0AD"), // CONCORD Assembly, CONCORD_COLOR
};
/** mapViewConst STAR_SIZE_AFFECTED x mapFilterConst STAR_SIZE_FACTOR_STANDARD; STAR_SIZE_UNIMPORTANT. */
const STAR_SIZE_FACTION = 60 * 0.5, STAR_SIZE_UNIMPORTANT = 8;
/** mapViewUtil CAMERA_DISTANCE_SCALING_FACTOR = 1 / SIZE_FACTOR_VALUE; BUBBLE_BASE_SIZE_MULTIPLIER. */
const CAMERA_DISTANCE_SCALING_FACTOR = 1 / 5000, BUBBLE_BASE_SIZE_MULTIPLIER = 1;
/** GetBase11ColorByID, for an NPC faction (idCheckers.IsNPC: every factionID); none: NEUTRAL_COLOR. */
export function starColour(factionID: number): [number, number, number] {
  if (!factionID) return NEUTRAL;
  return FACTION_COLOR[factionID] ?? BASE11[factionID % 11]!;
}
/** WorldPosToMapPos, then into three's handedness (EVE's z mirrored). */
export function mapPosition(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(-x * UNIVERSE_SCALE, -y * UNIVERSE_SCALE, -(z * UNIVERSE_SCALE));
}

export interface StarMapSystems {
  readonly systems: ReadonlyArray<readonly [number, number, number, number, number, number, number]>;
  readonly jumps: ReadonlyArray<readonly [number, number]>;
}

const STAR_VS = `
  attribute vec3 iPos; attribute vec3 iColour;
  uniform vec2 distanceRange;
  varying vec4 vColour; varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float d2 = dot(mv.xyz, mv.xyz) + 1.0;
    float d = sqrt(d2);
    // sin(atan(1 / P[1][1])): the sine of half the vertical field of view
    float sinHalf = sin(atan(1.0 / projectionMatrix[1][1]));
    float k = pow(abs(sinHalf * d2), 0.185) * 0.2274;
    float s = min(d * 0.003333, 1.0) * 25.0;
    mv.xy += k * s * position.xy;
    gl_Position = projectionMatrix * mv;
    float nearFade = clamp(distanceRange.x / d, 0.1, 1.0);
    float farFade = max(1.0 - d / (distanceRange.y - distanceRange.x), 0.25);
    vColour = vec4(iColour, nearFade * farFade);
    vUv = uv;
  }`;
const STAR_FS = `
  uniform sampler2D texMap; uniform float hasTex;
  varying vec4 vColour; varying vec2 vUv;
  void main() {
    vec4 t = hasTex > 0.5 ? texture2D(texMap, vUv) : vec4(1.0);
    gl_FragColor = t * vColour;
  }`;
const BUBBLE_VS = `
  attribute vec3 iPos; attribute vec3 iColour; attribute float iSize;
  uniform vec2 distanceRange; uniform vec4 sizeControls; uniform float cameraDistanceScalingFactor;
  varying vec4 vColour; varying vec2 vUv;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float d = sqrt(dot(mv.xyz, mv.xyz) + 1.0);
    float fade = clamp(distanceRange.x / d, 0.8, 1.0);
    vColour = vec4(iColour, 1.0) * fade;
    mv.xy += d * cameraDistanceScalingFactor * iSize * sizeControls.x * position.xy;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
  }`;
const BUBBLE_FS = `
  uniform sampler2D heat; uniform float hasHeat;
  varying vec4 vColour; varying vec2 vUv;
  void main() {
    if (hasHeat < 0.5) discard;
    gl_FragColor = texture2D(heat, vUv) * vColour;
  }`;
/** mapViewConst.py; const.AU. */
const AU = 149597870700;
const JUMPLINE_BASE_WIDTH = 3.0, REGION_LINE_TICKSIZE = AU * 8000 * UNIVERSE_SCALE, CONSTELLATION_LINE_TICKSIZE = AU * 4000 * UNIVERSE_SCALE;
const LINE_COLOR: [number, number, number] = [0.5, 0.5, 0.5];
/** LineOpacityFinder3D.GetLineDefaultOpacity, VIEWMODE_LINES_ALL (the default line mode). */
const LINE_OPACITY_DEFAULT = 0.2;
const LINE_VS = `
  attribute vec4 lineDir; attribute vec4 beginEnd; attribute vec2 animation;
  attribute vec4 colour; attribute vec4 overrideColour; attribute vec4 overlayColour;
  uniform vec2 distanceRange; uniform vec2 targetResolution;
  varying vec4 vSide; varying vec2 vAlong; varying vec4 vColour; varying vec4 vOverride; varying vec4 vOverlay; varying vec2 vAnimation;
  void main() {
    float end = beginEnd.x - 0.5;
    float sgn = end + end;
    float ext = sgn * abs(lineDir.w);
    vec4 otherClip = projectionMatrix * modelViewMatrix * vec4(position + lineDir.xyz, 1.0);
    vec4 here = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec2 dir = (otherClip.xy / otherClip.w - here.xy / here.w) * targetResolution * sgn;
    vec2 off = ext * normalize(dir);
    float len = length(dir);
    vec2 across = normalize(vec2(dir.y, -dir.x));
    off += lineDir.w * across;
    gl_Position = vec4(here.xy + off / targetResolution * here.w, here.z, here.w);
    vSide.x = (sign(lineDir.w) + 1.0) * 0.5;
    vSide.y = beginEnd.x;
    float cap = abs(lineDir.w) / (2.0 * abs(lineDir.w) + len);
    vSide.zw = vec2(cap, 1.0 - cap);
    vAlong = vec2(2.0 * (beginEnd.w / len * abs(lineDir.w)) * end + beginEnd.y, beginEnd.z);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = sqrt(dot(mv.xyz, mv.xyz) + 1.0);
    float nearFade = clamp(distanceRange.x / d, 0.1, 1.0);
    float farFade = max(1.0 - d / (distanceRange.y - distanceRange.x), 0.25);
    vColour = vec4(colour.rgb, farFade * colour.a * nearFade);
    vOverride = overrideColour; vOverlay = overlayColour; vAnimation = animation;
  }`;
const LINE_FS = `
  uniform sampler2D texMap; uniform sampler2D overlayTexMap; uniform float hasTex; uniform float time;
  varying vec4 vSide; varying vec2 vAlong; varying vec4 vColour; varying vec4 vOverride; varying vec4 vOverlay; varying vec2 vAnimation;
  void main() {
    if (hasTex < 0.5) discard;
    vec3 c = mix(vOverride.rgb, vColour.rgb, vAlong.x >= vAlong.y ? 1.0 : 0.0);
    float endCap = vSide.w < vSide.y ? (vSide.y - vSide.w) / (1.0 - vSide.w) * 0.5 + 0.5 : 0.5;
    float v = vSide.y < vSide.z ? vSide.y / vSide.z * 0.5 : endCap;
    vec4 t = texture2D(texMap, vec2(vSide.x, v));
    vec4 o = texture2D(overlayTexMap, vec2(vSide.x, (vAnimation.x * time + vAlong.x) * vAnimation.y));
    float oa = 1.0 + vOverlay.a * (o.a - 1.0);
    gl_FragColor = vec4(c * t.rgb + o.rgb * vOverlay.rgb, t.a * vColour.a * oa);
  }`;

export class StarMap {
  readonly root = document.createElement("div");
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly starUniforms = { distanceRange: { value: new THREE.Vector2(1, 4) }, texMap: { value: null as THREE.Texture | null }, hasTex: { value: 0 } };
  private readonly lineUniforms = {
    distanceRange: { value: new THREE.Vector2(1, 400) }, targetResolution: { value: new THREE.Vector2(1, 1) }, time: { value: 0 },
    texMap: { value: null as THREE.Texture | null }, overlayTexMap: { value: null as THREE.Texture | null }, hasTex: { value: 0 },
  };
  private readonly bubbleUniforms = {
    distanceRange: this.starUniforms.distanceRange, sizeControls: { value: new THREE.Vector4(BUBBLE_BASE_SIZE_MULTIPLIER, 1, 1, 1) },
    cameraDistanceScalingFactor: { value: CAMERA_DISTANCE_SCALING_FACTOR }, heat: { value: null as THREE.Texture | null }, hasHeat: { value: 0 },
  };
  private readonly positions = new Map<number, THREE.Vector3>();
  private running = false;
  /** How many stars and jump lines are drawn (for checks). */
  stars = 0;
  jumps = 0;

  constructor() {
    this.root.className = "star-map";
    this.root.style.cssText = "position:absolute;inset:0;background:#000;z-index:5;";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.root.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block;";
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(1.0), 1, 0.1, MAX_CAMERA_DISTANCE * 4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = MIN_CAMERA_DISTANCE;
    this.controls.maxDistance = MAX_CAMERA_DISTANCE;
    this.controls.enableDamping = true;
    // (mapStarNew5.dds and mapStarNewHeat.dds are one uncompressed level each: a mipmapped filter samples black)
    const level = async (url: string) => {
      const t = await loadDds(url);
      if (!t.mipmaps?.length) { t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; }
      return t;
    };
    void fetch("/client-assets/starmap.json").then((r) => r.json()).then(async (m: { textures?: Record<string, string | null> }) => {
      if (m.textures?.star) { this.starUniforms.texMap.value = await level(m.textures.star); this.starUniforms.hasTex.value = 1; }
      if (m.textures?.heat) { this.bubbleUniforms.heat.value = await level(m.textures.heat); this.bubbleUniforms.hasHeat.value = 1; }
      if (m.textures?.line && m.textures?.lineOverlay) {
        const [line, overlay] = await Promise.all([level(m.textures.line), level(m.textures.lineOverlay)]);
        // (the samplers wrap: EveSpaceSceneEnvMapSampler's address wrap, wrap)
        for (const t of [line, overlay]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
        this.lineUniforms.texMap.value = line; this.lineUniforms.overlayTexMap.value = overlay; this.lineUniforms.hasTex.value = 1;
      }
    }).catch((e) => console.warn("star map textures", e));
  }

  /** The universe laid out (CreateStarParticles, CreateJumpLineSet), the camera on a system. */
  build(data: StarMapSystems, focusSystemID: number | null): void {
    const colours = new Map<number, [number, number, number]>();
    const within = new Map<number, [number, number]>();
    const iPos: number[] = [], iColour: number[] = [], iSize: number[] = [];
    for (const [id, x, y, z, factionID, regionID, constellationID] of data.systems) {
      within.set(id, [regionID, constellationID]);
      const p = mapPosition(x, y, z);
      this.positions.set(id, p);
      const c = starColour(factionID);
      colours.set(id, c);
      iPos.push(p.x, p.y, p.z);
      iColour.push(...c);
      iSize.push(factionID ? STAR_SIZE_FACTION : STAR_SIZE_UNIMPORTANT);
    }
    const plane = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute("position", plane.getAttribute("position"));
    geometry.setAttribute("uv", plane.getAttribute("uv"));
    geometry.setAttribute("iPos", new THREE.InstancedBufferAttribute(new Float32Array(iPos), 3));
    geometry.setAttribute("iColour", new THREE.InstancedBufferAttribute(new Float32Array(iColour), 3));
    geometry.setAttribute("iSize", new THREE.InstancedBufferAttribute(new Float32Array(iSize), 1));
    geometry.instanceCount = data.systems.length;
    const starMat = new THREE.ShaderMaterial({ uniforms: this.starUniforms, vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    logDepth(starMat);
    const stars = new THREE.Mesh(geometry, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 2;
    this.scene.add(stars);
    // the second pass, after the first
    const bubbleMat = new THREE.ShaderMaterial({ uniforms: this.bubbleUniforms, vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    logDepth(bubbleMat);
    const bubbles = new THREE.Mesh(geometry, bubbleMat);
    bubbles.frustumCulled = false;
    bubbles.renderOrder = 3;
    this.scene.add(bubbles);
    this.stars = data.systems.length;
    // the jump lines (LoadJumpLines, UpdateLineColorAndWidth): six vertices each, as WriteLineVerticesToBuffer
    const pos: number[] = [], dir: number[] = [], be: number[] = [], anim: number[] = [], col: number[] = [], ovr: number[] = [], ovl: number[] = [];
    let count = 0;
    for (const [a, b] of data.jumps) {
      const pa = this.positions.get(a), pb = this.positions.get(b);
      if (!pa || !pb) continue;
      const [ra, ca] = within.get(a) ?? [0, 0], [rb, cb] = within.get(b) ?? [0, 0];
      const region = ra !== rb, constellation = !region && ca !== cb;
      const length = pa.distanceTo(pb);
      // LINE_COLOR, a region jump's SetBrightness(0.9) (it is grey), the default opacity
      const c = region ? [0.9, 0.9, 0.9] : LINE_COLOR;
      const width = JUMPLINE_BASE_WIDTH * (region ? 1.6 : constellation ? 1.3 : 1);
      const overlay = region || constellation ? [0, 0, 0, 1] : [0, 0, 0, 0];
      const scale = region ? length / REGION_LINE_TICKSIZE : constellation ? length / CONSTELLATION_LINE_TICKSIZE : 1;
      const d = pb.clone().sub(pa);
      // [end (0 pos1, 1 pos2), sign of the width]: tri0 (0 -, 0 +, 1 -), tri1 (0 +, 1 +, 1 -)
      for (const [end, side] of [[0, -1], [0, 1], [1, -1], [0, 1], [1, 1], [1, -1]] as const) {
        const p = end ? pb : pa, w = d.clone().multiplyScalar(end ? -1 : 1);
        pos.push(p.x, p.y, p.z);
        dir.push(w.x, w.y, w.z, side * width);
        be.push(end, end, -1, 1);
        anim.push(0, scale);
        col.push(c[0]!, c[1]!, c[2]!, LINE_OPACITY_DEFAULT);
        ovr.push(0, 0, 0, 0);
        ovl.push(...overlay);
      }
      count++;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute("lineDir", new THREE.Float32BufferAttribute(dir, 4));
    lg.setAttribute("beginEnd", new THREE.Float32BufferAttribute(be, 4));
    lg.setAttribute("animation", new THREE.Float32BufferAttribute(anim, 2));
    lg.setAttribute("colour", new THREE.Float32BufferAttribute(col, 4));
    lg.setAttribute("overrideColour", new THREE.Float32BufferAttribute(ovr, 4));
    lg.setAttribute("overlayColour", new THREE.Float32BufferAttribute(ovl, 4));
    const lineMat = new THREE.ShaderMaterial({ uniforms: this.lineUniforms, vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    logDepth(lineMat);
    const lines = new THREE.Mesh(lg, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    this.scene.add(lines);
    this.jumps = count;
    this.focus(focusSystemID);
  }

  /** The camera on a system (LoadStarLayout(activeItemID)), at ZOOM_DIST_SYSTEM from it, looking down (the default eye). */
  focus(systemID: number | null): void {
    const at = (systemID !== null ? this.positions.get(systemID) : null) ?? new THREE.Vector3();
    this.controls.target.copy(at);
    // mapCamera default_eyePosition (0, DEFAULT_MAP_EYE_Y, -50): from above, a little behind; EVE's z mirrored
    this.camera.position.copy(at).add(new THREE.Vector3(0, 10000, 50).setLength(ZOOM_DIST_SYSTEM));
    this.controls.update();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(() => this.frame());
  }
  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  frame(): void {
    const w = this.root.clientWidth || innerWidth, h = this.root.clientHeight || innerHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) { this.renderer.setSize(w, h, false); this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix(); }
    this.controls.update();
    // OnCameraUpdate: the far clip the camera's distance and the universe's size; the distance ranges
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = 0.1;
    this.camera.far = distance + 40000;
    this.camera.updateProjectionMatrix();
    const fadeOutFar = Math.max(100, distance * 4);
    this.starUniforms.distanceRange.value.set(distance, fadeOutFar);
    this.lineUniforms.distanceRange.value.set(distance, fadeOutFar * 100);
    this.lineUniforms.targetResolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.lineUniforms.time.value = performance.now() / 1000;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
