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
// - the markers (markers/mapMarkersHandler.py): the current system the selected item (LoadStarLayout(activeItemID));
//   _UpdateActiveMarkers / GetActiveAndSelectedIdsSolarSystem: its gate neighbours and its constellation's systems
//   active, it selected; a system's MarkerLabelSolarSystem (normal, not abstract, content: MarkerContainerContentSimple
//   - its name in EveLabelSmall bold, TextColor.NORMAL (1, 1, 1, 0.75), LABEL_LEFT 22 px right of the point, centred
//   on it) shown while active or selected (maxDispRange 0 otherwise), its opacity OPACITY_MARKER_ACTIVE 1 selected,
//   else GetMarkerBaseOpacity(camera distance, 0, 17500) = 1 - d / 17500; MarkerMyLocation ("You are here", always
//   shown, opacity 1): MarkerIconBase's 14 px container 30 px above the point (projectBracket.offsetY -30), the
//   focusIcon.png 16 px in it, tagBackground.png 64 px under it 12 px down.
// - selecting (mapView.SetActiveItemID: a click on a star - here the nearest star within 8 px of the click - makes it
//   the active item: its markers active as above, the camera's point of interest moved to it, FocusCameraOnActiveEntity,
//   at the distance it has) and hovering (the markers handler's hilight: the label shown at full opacity with
//   CheckConstructHiliteContainer's dashed circle, 4 dashes, radius CIRCLESIZE / 2 = 7, line 0.8);
// - the lines' opacity by LineOpacityFinder3D: each line of each system of the active constellation (the selected
//   system's) += OPACITY_LINES_SELECTED 1.0, and while a system is hovered += OPACITY_LINES_HOVERED 0.3 - for the same
//   active constellation (_UpdateLineOpacitySolarSystem takes _activeConstellationID whichever system is given); a line
//   in none keeps the default 0.2; the colour's alpha that, as a UBYTE4N colour clamps it, at most 1.
// - the route (UpdateAutopilotJumpRoute: the destination path from the pilot's system, _UpdatePathLineAppearance): each
//   line of it ApplyJumpLineColorAndWidth - each end the colour of its system's security (mapSvc.GetModifiedSystemColor:
//   FmtSystemSecStatus's colour) at alpha 2.0 (1 once a UBYTE4N colour), AUTOPILOT_LINE_WIDTH (3 x 2) - and
//   ChangeLineAnimation((0, 0, 0, 0.75), AUTOPILOT_LINE_ANIM_SPEED / scale x direction, scale = length /
//   AUTOPILOT_LINE_TICKSIZE (AU x 10000 x UNIVERSE_SCALE)), the direction -1 where the route runs from the line's first
//   end; set after the opacities, which it overrides.
// - the layouts (layout/mapLayoutSolarSystems.py PrimeLayout, mapViewUtil.GetSolarSystemCoordinates): the solar
//   systems' own (WorldPosToMapPos(center)) or the abstract one, where the coordinate overrider has the system
//   (evemap/map2d/overriddenCoordinates.py: bin:/packages/evemap/overriddenCoordinates.json's 2D pos) at
//   WorldPosToMapPos((x, 0, z)); a change of layout moves each star linearly from where it is to where it goes over
//   transformTime 500 ms (mapLayoutHandler: UpdateAnimPosition's Vec3Lerp into the particle's first position, each
//   line's ends with it - UpdateLinePosition).
// - in the abstract layout (mapViewWorld.UpdateCameraForAbstractView): the 2D map camera (camera/mapCamera.py
//   Make2DCamera: kMinPitch 0.005, yaw to 0 and pitch to it over 1 s, no orbiting - a drag pans -, zoom between
//   MIN_CAMERA_DISTANCE_2DVIEW 3100 and MAX_CAMERA_DISTANCE_2DVIEW 310000; Make3DCamera back to 1 - 160000), and the
//   lines' opacity by LineOpacityFinderAbstract: the default 0.4 while the zoom value (baseCamera GetZoomProportion:
//   ((d - 3100) / (310000 - 3100)) ^ (1 / kZoomPower 9)) is under MAP2D_ZOOM_TUBE_BUBBLE 0.75, else 0.3; each line of
//   the active region's systems and of the systems next to it in other regions + that default, the hovered system's
//   lines + the default (GetBaseOpacityForHoveredLines), the selected system's + OPACITY_LINES_SELECTED 1.0; a line in
//   none the default (GetLineColor's lineAlphaByLineID.get(lineID, baseLineAlphaModulate): its region argument is
//   never read - the compiled code has no load of it).
// - the abstract mode's sprites by zoom value (MapViewWorld._GetSpriteEffectPathAndStaticSize): under
//   MAP2D_ZOOM_TUBE_MARKER 0.66 SpriteValues(MARKER_BIG, disk.dds, TUBE_BUBBLE_SIZE 200, mode 1,
//   EXTRA_BUBBLE_BIG_SIZE_FACTOR 7.6), under MAP2D_ZOOM_TUBE_BUBBLE 0.75 (MARKER_MEDIUM, ..., 4.5), else the filter's
//   (MARKER_NONE, its texture, no static size, mode 0, 0): the bubbles at the static size, in sprite mode 1 - the
//   IconAtlasTex (MapStaticDataCircles_01h, AtlasConfiguration 3 x 3) cell of the star's shape (_GetDataTextureShape:
//   big 1 for the active item, else 0; medium 4 where it is no preview bubble), its rgb lerp(TexBackgroundColor (0, 0,
//   0, 1), colour, atlas r), alpha min(2 a atlas a, 1); the extra star particles (extraStarParticles.py
//   WorldMapExtraDataTextureController: StarmapNew.fx again, HeatTexture circleScalingOpacity25.dds, each the star's
//   colour at sizeFactor x its star size, shown in the abstract mode) under them; the markers' abstract content
//   (MarkerContainerContentAdvanced._GetMarkerSizeToUse: big, every system's name centred under its bubble -
//   (size + text height) / 2 + 3 below, size GetSizeForUIElement(TUBE_BUBBLE_CONTENT_BIG 145.3, viewport height,
//   1) = 145.3 / 5000 x it - at NAME_OPACITY_FULL 0.75; otherwise MARKER_NONE: only a selected or hilighted system's
//   name, at LABEL_LEFT);
// - the map opens in the abstract layout (VIEWMODE_LAYOUT_SHOW_ABSTRACT_DEFAULT True).
// - the medium zoom's preview bubbles (MapViewWorld.PickSceneNearMouse / GetObjectsNearMouse: the systems whose
//   points are within GetSizeForUIElement(PREVIEW_PICKER_SIZE 1400, ...) px of the mouse, and the active one; ClearNearMouse
//   leaves the active one): shape 5 (6 the active one) for them, 4 for the rest; their names centred under the medium
//   content (TUBE_BUBBLE_CONTENT_MEDIUM 106.25), opacity 0 past MAP2D_ZOOM_NO_SYSTEM_NAME 0.71, else NAME_OPACITY_FAINT
//   0.3 + t x 0.45 with t = (zoom - 0.71) / (0.66 - 0.71), the selected one's 0.75;
// - in the abstract layout the lines' distance range (MAX_CAMERA_DISTANCE_2DVIEW, x 10000)
//   (MapViewWorld._UpdateDistanceRangeValues).
// Not yet: constellation and region markers; the my-location marker's pulse
// circles (three circleFilled256 rings, alpha to 0.02).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadDds } from "../three/ddsTexture.ts";
import { logDepth } from "../three/logDepth.ts";
import { securityStatusRgb } from "../bridge/systemSecurity.ts";

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
  readonly systems: ReadonlyArray<readonly [number, number, number, number, number, number, number, string?, (number | null)?]>;
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
  attribute vec3 iPos; attribute vec3 iColour; attribute float iSize; attribute float iShape;
  uniform vec2 distanceRange; uniform vec4 sizeControls; uniform float cameraDistanceScalingFactor;
  uniform float staticSize; uniform float sizeFactor; uniform vec4 atlasConfiguration;
  varying vec4 vColour; varying vec2 vUv; varying vec4 vAtlas;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float d = sqrt(dot(mv.xyz, mv.xyz) + 1.0);
    float fade = clamp(distanceRange.x / d, 0.8, 1.0);
    vColour = vec4(iColour, 1.0) * fade;
    float size = staticSize > 0.0 ? staticSize : iSize * sizeFactor;
    mv.xy += d * cameraDistanceScalingFactor * size * sizeControls.x * position.xy;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    // the shape's cell of the atlas: (shape mod columns) / columns, floor(shape / rows) / rows
    float cols = atlasConfiguration.x, rows = atlasConfiguration.y;
    vAtlas = vec4(fract(iShape / cols) * cols / cols, floor(iShape / rows) / rows, cols, rows);
  }`;
const BUBBLE_FS = `
  uniform sampler2D heat; uniform float hasHeat; uniform sampler2D iconAtlas; uniform float hasAtlas;
  uniform float spriteMode; uniform vec4 texBackgroundColor;
  varying vec4 vColour; varying vec2 vUv; varying vec4 vAtlas;
  void main() {
    if (hasHeat < 0.5) discard;
    vec4 h = texture2D(heat, vUv);
    vec4 heatPixel = h * vColour;
    if (spriteMode < 0.5) { gl_FragColor = heatPixel; return; }
    if (hasAtlas < 0.5) discard;
    vec4 a = texture2D(iconAtlas, vUv / vAtlas.zw + vAtlas.xy);
    vec4 shape = vec4(mix(texBackgroundColor.rgb, vColour.rgb, a.r), min(2.0 * vColour.a * a.a, 1.0));
    gl_FragColor = heatPixel + spriteMode * (shape - vColour * h);
  }`;
/** mapViewConst.py; const.AU. */
const AU = 149597870700;
const AUTOPILOT_LINE_TICKSIZE = AU * 10000 * UNIVERSE_SCALE, AUTOPILOT_LINE_ANIM_SPEED = 1.0;
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
    staticSize: { value: 0 }, sizeFactor: { value: 1 }, atlasConfiguration: { value: new THREE.Vector4(3, 3, 1, 1) },
    iconAtlas: { value: null as THREE.Texture | null }, hasAtlas: { value: 0 }, spriteMode: { value: 0 }, texBackgroundColor: { value: new THREE.Vector4(0, 0, 0, 1) },
  };
  /** The extra star particles' (the abstract mode's discs): the same shader in mode 0 at sizeFactor x the star size. */
  private readonly extraUniforms = {
    distanceRange: this.starUniforms.distanceRange, sizeControls: { value: new THREE.Vector4(BUBBLE_BASE_SIZE_MULTIPLIER, 1, 1, 1) },
    cameraDistanceScalingFactor: { value: CAMERA_DISTANCE_SCALING_FACTOR }, heat: { value: null as THREE.Texture | null }, hasHeat: { value: 0 },
    staticSize: { value: 0 }, sizeFactor: { value: 0 }, atlasConfiguration: { value: new THREE.Vector4(3, 3, 1, 1) },
    iconAtlas: { value: null as THREE.Texture | null }, hasAtlas: { value: 0 }, spriteMode: { value: 0 }, texBackgroundColor: { value: new THREE.Vector4(0, 0, 0, 1) },
  };
  /** The filter's heat texture and the tube texture (the bubble pass's HeatTexture by the sprite values). */
  private heatTex: THREE.Texture | null = null;
  private tubeTex: THREE.Texture | null = null;
  private shapes: THREE.InstancedBufferAttribute | null = null;
  private extraMesh: THREE.Mesh | null = null;
  /** The marker size type the abstract sprites are at (MARKER_NONE / MEDIUM / BIG), and the big markers' names. */
  markerSize: "none" | "medium" | "big" = "none";
  /** The mouse over the map (page coordinates), and the preview bubbles' systems (previewBubbleMarkerIDs). */
  private mouse: { x: number; y: number } | null = null;
  preview = new Set<number>();
  private zoomValue = 1;
  private bigNames = new Map<number, HTMLDivElement>();
  private readonly positions = new Map<number, THREE.Vector3>();
  /** Each system's place in the two layouts, and the stars' position attribute. */
  private readonly layouts = { own: new Map<number, THREE.Vector3>(), abstract: new Map<number, THREE.Vector3>() };
  private abstractUrl: string | null = null;
  private starPos: THREE.InstancedBufferAttribute | null = null;
  private starOrder: number[] = [];
  private linePos: THREE.BufferAttribute | null = null;
  /** The layout shown, and its change under way (from each star's place then, since when). */
  abstract = false;
  private morph: { from: Map<number, THREE.Vector3>; at: number } | null = null;
  /** The camera's turn to the 2D view (Make2DCamera's morph of pitch and yaw), and the abstract default opacity in use. */
  private turn: { from: THREE.Vector3; at: number } | null = null;
  private abstractDefault = 0.4;
  private running = false;
  /** The markers' layer over the canvas, the labels of the active systems and the my-location marker. */
  private readonly markers = document.createElement("div");
  private labels: { id: number; at: THREE.Vector3; el: HTMLDivElement; selected: boolean; hover?: boolean }[] = [];
  /** What the map was built of, for selecting: the data, each system's region and constellation, each name. */
  private data: StarMapSystems | null = null;
  private within = new Map<number, [number, number]>();
  private names = new Map<number, string>();
  /** Each line's two systems, by its index, and the colour attribute its alpha goes into. */
  private lineEnds: [number, number][] = [];
  private lineColours: THREE.BufferAttribute | null = null;
  /** Each line's own look (UpdateLineColorAndWidth's), put back where the route leaves it, and the attributes. */
  private lineLooks: { rgb: number[]; width: number; overlay: number[]; scale: number }[] = [];
  private lineAttrs: { dir: THREE.BufferAttribute; anim: THREE.BufferAttribute; ovl: THREE.BufferAttribute } | null = null;
  /** The route's lines, by index: the system it runs from. */
  private routeLines = new Map<number, number>();
  private security = new Map<number, number>();
  /** How many lines the route holds (for checks). */
  get routeLength(): number { return this.routeLines.size; }
  /** The pilot's system (the my-location marker), the active (selected) item and the hovered system. */
  private hereID: number | null = null;
  selectedID: number | null = null;
  hoverID: number | null = null;
  private hoverLabel: { el: HTMLDivElement; at: THREE.Vector3 } | null = null;
  /** The camera's move to a newly selected system: from where, to where, since when. */
  private move: { from: THREE.Vector3; to: THREE.Vector3; at: number } | null = null;
  private myLocation: { at: THREE.Vector3; el: HTMLDivElement } | null = null;
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
    this.markers.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    this.root.appendChild(this.markers);
    // a click (not a drag) selects the star under it; a move hovers one
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
        const id = this.starAt(e.clientX, e.clientY);
        if (id !== null) this.select(id);
      }
      down = null;
    });
    canvas.addEventListener("pointermove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (!down) this.hover(this.starAt(e.clientX, e.clientY));
      this.pickNearMouse();
    });
    canvas.addEventListener("pointerleave", () => { this.hover(null); this.mouse = null; this.pickNearMouse(); });
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
    void fetch("/client-assets/starmap.json").then((r) => r.json()).then(async (m: { textures?: Record<string, string | null>; abstract?: string | null }) => {
      this.abstractUrl = m.abstract ?? null;
      if (m.textures?.star) { this.starUniforms.texMap.value = await level(m.textures.star); this.starUniforms.hasTex.value = 1; }
      if (m.textures?.heat) { this.heatTex = await level(m.textures.heat); this.bubbleUniforms.heat.value = this.heatTex; this.bubbleUniforms.hasHeat.value = 1; }
      if (m.textures?.tube) this.tubeTex = await level(m.textures.tube);
      if (m.textures?.iconAtlas) { const t = await level(m.textures.iconAtlas); this.bubbleUniforms.iconAtlas.value = t; this.bubbleUniforms.hasAtlas.value = 1; }
      if (m.textures?.extra) { this.extraUniforms.heat.value = await level(m.textures.extra); this.extraUniforms.hasHeat.value = 1; }
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
    const names = new Map<number, string>();
    for (const s of data.systems) { names.set(s[0], s[7] ?? ""); if (typeof s[8] === "number") this.security.set(s[0], s[8]); }
    const iPos: number[] = [], iColour: number[] = [], iSize: number[] = [];
    for (const [id, x, y, z, factionID, regionID, constellationID] of data.systems) {
      within.set(id, [regionID, constellationID]);
      const p = mapPosition(x, y, z);
      this.layouts.own.set(id, p.clone());
      this.positions.set(id, p);
      this.starOrder.push(id);
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
    this.starPos = new THREE.InstancedBufferAttribute(new Float32Array(iPos), 3);
    geometry.setAttribute("iPos", this.starPos);
    geometry.setAttribute("iColour", new THREE.InstancedBufferAttribute(new Float32Array(iColour), 3));
    geometry.setAttribute("iSize", new THREE.InstancedBufferAttribute(new Float32Array(iSize), 1));
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(iSize.length), 1);
    geometry.setAttribute("iShape", this.shapes);
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
    // the extra star particles (the abstract mode's discs)
    const extraMat = new THREE.ShaderMaterial({ uniforms: this.extraUniforms, vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    logDepth(extraMat);
    this.extraMesh = new THREE.Mesh(geometry, extraMat);
    this.extraMesh.frustumCulled = false;
    // (mapView.CreateStarParticles appends extraMapStars after mapStars: drawn after both of its passes)
    this.extraMesh.renderOrder = 4;
    this.extraMesh.visible = false;
    this.scene.add(this.extraMesh);
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
      this.lineEnds.push([a, b]);
      this.lineLooks.push({ rgb: [...c], width, overlay: [...overlay], scale });
      count++;
    }
    const lg = new THREE.BufferGeometry();
    this.linePos = new THREE.Float32BufferAttribute(pos, 3);
    lg.setAttribute("position", this.linePos);
    lg.setAttribute("lineDir", new THREE.Float32BufferAttribute(dir, 4));
    lg.setAttribute("beginEnd", new THREE.Float32BufferAttribute(be, 4));
    lg.setAttribute("animation", new THREE.Float32BufferAttribute(anim, 2));
    this.lineColours = new THREE.Float32BufferAttribute(col, 4);
    lg.setAttribute("colour", this.lineColours);
    lg.setAttribute("overrideColour", new THREE.Float32BufferAttribute(ovr, 4));
    lg.setAttribute("overlayColour", new THREE.Float32BufferAttribute(ovl, 4));
    this.lineAttrs = { dir: lg.getAttribute("lineDir") as THREE.BufferAttribute, anim: lg.getAttribute("animation") as THREE.BufferAttribute, ovl: lg.getAttribute("overlayColour") as THREE.BufferAttribute };
    const lineMat = new THREE.ShaderMaterial({ uniforms: this.lineUniforms, vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    logDepth(lineMat);
    const lines = new THREE.Mesh(lg, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    this.scene.add(lines);
    this.jumps = count;
    this.data = data;
    this.within = within;
    this.names = names;
    this.hereID = focusSystemID;
    this.buildMarkers(data, within, names, focusSystemID);
    this.selectedID = focusSystemID;
    this.updateLineOpacity();
    this.focus(focusSystemID);
  }

  /** The nearest star within 8 px of a point on the page, or null. */
  starAt(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const v = new THREE.Vector3();
    let best: number | null = null, bestD = 8;
    for (const [id, p] of this.positions) {
      v.copy(p).project(this.camera);
      if (v.z <= -1 || v.z >= 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * r.width - x, (1 - v.y) / 2 * r.height - y);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** SetActiveItemID: the system selected, its markers active, the camera's point of interest moved to it. */
  select(systemID: number): void {
    if (!this.data || !this.positions.has(systemID)) return;
    this.selectedID = systemID;
    this.buildMarkers(this.data, this.within, this.names, systemID);
    this.updateLineOpacity();
    this.move = { from: this.controls.target.clone(), to: this.positions.get(systemID)!.clone(), at: performance.now() };
  }

  /** The hilight: the hovered system's label shown, a dashed circle on it; the active constellation's lines + 0.3. */
  hover(systemID: number | null): void {
    if (systemID === this.hoverID) return;
    this.hoverID = systemID;
    this.hoverLabel?.el.remove();
    this.hoverLabel = null;
    if (systemID !== null && this.positions.has(systemID)) {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;white-space:nowrap;";
      // CheckConstructHiliteContainer: CIRCLESIZE 14 at the point, a DashedCircle of 4 dashes, radius 7, line 0.8
      el.innerHTML = '<svg width="14" height="14" style="position:absolute;left:0;top:0;overflow:visible"><circle cx="7" cy="7" r="6.6" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="0.8" stroke-dasharray="5.18 5.18"/></svg>';
      const t = document.createElement("span");
      t.textContent = this.names.get(systemID) ?? "";
      t.style.cssText = "position:absolute;left:22px;top:1px;font-size:10px;line-height:12px;font-weight:700;color:rgba(255,255,255,0.75);"
        + "font-family:'EVE Sans Neue','Barlow Semi Condensed','Segoe UI',sans-serif;";
      el.appendChild(t);
      this.markers.appendChild(el);
      this.hoverLabel = { el, at: this.positions.get(systemID)! };
    }
    this.updateLineOpacity();
  }

  /**
   * The layout: the solar systems' own, or the abstract one (its positions read once); each star moved from where it
   * is to its place in it over 500 ms, the lines with them.
   */
  async setLayout(abstract: boolean): Promise<void> {
    if (abstract && this.layouts.abstract.size === 0) {
      if (!this.abstractUrl) return;
      const coords = await fetch(this.abstractUrl).then((r) => r.json()) as Record<string, [number, number]>;
      for (const [id, own] of this.layouts.own) {
        const c = coords[String(id)];
        this.layouts.abstract.set(id, c ? mapPosition(c[0], 0, c[1]) : own.clone());
      }
    }
    this.abstract = abstract;
    // UpdateCameraForAbstractView: Make2DCamera / Make3DCamera
    if (abstract) {
      this.controls.enableRotate = false;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      this.controls.screenSpacePanning = false;
      this.controls.minDistance = 3100;
      this.controls.maxDistance = 310000;
      this.turn = { from: this.camera.position.clone().sub(this.controls.target), at: performance.now() };
    } else {
      this.controls.enableRotate = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.controls.minDistance = MIN_CAMERA_DISTANCE;
      this.controls.maxDistance = MAX_CAMERA_DISTANCE;
      this.turn = null;
    }
    this.updateLineOpacity();
    const from = new Map<number, THREE.Vector3>();
    for (const [id, p] of this.positions) from.set(id, p.clone());
    this.morph = { from, at: performance.now() };
  }

  /** One step of a layout change: each star's place, its particle, its lines' ends. */
  private stepLayout(now: number): void {
    if (!this.morph || !this.starPos || !this.linePos) return;
    const t = Math.min(1, (now - this.morph.at) / 500);
    const target = this.abstract ? this.layouts.abstract : this.layouts.own;
    // (the camera's point of interest moves with the active item, as the map keeps its camera on it)
    const sel = this.selectedID !== null ? this.positions.get(this.selectedID)?.clone() ?? null : null;
    for (const [id, p] of this.positions) p.lerpVectors(this.morph.from.get(id)!, target.get(id)!, t);
    if (sel && this.selectedID !== null && !this.move) {
      const delta = this.positions.get(this.selectedID)!.clone().sub(sel);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    const sp = this.starPos.array as Float32Array;
    this.starOrder.forEach((id, i) => { const p = this.positions.get(id)!; sp[i * 3] = p.x; sp[i * 3 + 1] = p.y; sp[i * 3 + 2] = p.z; });
    this.starPos.needsUpdate = true;
    const lp = this.linePos.array as Float32Array, dir = this.lineAttrs!.dir.array as Float32Array;
    this.lineEnds.forEach(([a, b], i) => {
      const pa = this.positions.get(a)!, pb = this.positions.get(b)!;
      for (let k = 0; k < 6; k++) {
        const v = i * 6 + k, end = k === 2 || k === 4 || k === 5;
        const p = end ? pb : pa, q = end ? pa : pb;
        lp[v * 3] = p.x; lp[v * 3 + 1] = p.y; lp[v * 3 + 2] = p.z;
        dir[v * 4] = q.x - p.x; dir[v * 4 + 1] = q.y - p.y; dir[v * 4 + 2] = q.z - p.z;
      }
    });
    this.linePos.needsUpdate = true;
    this.lineAttrs!.dir.needsUpdate = true;
    if (t >= 1) this.morph = null;
  }

  /** PickSceneNearMouse / ClearNearMouse: the preview bubbles' systems at the medium zoom, their shapes redone. */
  private pickNearMouse(): void {
    const next = new Set<number>();
    if (this.abstract && this.markerSize === "medium") {
      if (this.selectedID !== null) next.add(this.selectedID);
      if (this.mouse) {
        const r = this.renderer.domElement.getBoundingClientRect();
        const box = 1400 / 5000 * r.height;
        const v = new THREE.Vector3();
        for (const [id, p] of this.positions) {
          v.copy(p).project(this.camera);
          if (v.z <= -1 || v.z >= 1) continue;
          const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
          if (x < r.left - 20 || x > r.right + 20 || y < r.top - 20 || y > r.bottom + 20) continue;
          if ((x - this.mouse.x) ** 2 + (y - this.mouse.y) ** 2 < box * box) next.add(id);
        }
      }
    }
    if (next.size === this.preview.size && [...next].every((id) => this.preview.has(id))) return;
    this.preview = next;
    if (this.markerSize === "medium") this.writeShapes("medium");
  }

  /** _GetDataTextureShape for every star at a marker size type. */
  private writeShapes(size: "medium" | "big"): void {
    if (!this.shapes) return;
    const a = this.shapes.array as Float32Array;
    this.starOrder.forEach((id, i) => {
      a[i] = size === "big" ? (id === this.selectedID ? 1 : 0) : !this.preview.has(id) ? 4 : id === this.selectedID ? 6 : 5;
    });
    this.shapes.needsUpdate = true;
  }

  /** ApplyStarColors / _UpdateDataShapeAndSize with the sprite values of a marker size type (MapViewWorld's). */
  private shapesFor: number | null = null;
  private applySpriteValues(size: "none" | "medium" | "big"): void {
    this.markerSize = size;
    this.shapesFor = this.selectedID;
    const b = this.bubbleUniforms;
    if (size === "none") {
      b.spriteMode.value = 0; b.staticSize.value = 0; b.sizeFactor.value = 1;
      b.heat.value = this.heatTex; b.hasHeat.value = this.heatTex ? 1 : 0;
      this.extraUniforms.sizeFactor.value = 0;
      if (this.extraMesh) this.extraMesh.visible = false;
    } else {
      b.spriteMode.value = 1; b.staticSize.value = 200;
      b.heat.value = this.tubeTex; b.hasHeat.value = this.tubeTex ? 1 : 0;
      this.extraUniforms.sizeFactor.value = size === "big" ? 7.6 : 4.5;
      if (this.extraMesh) this.extraMesh.visible = true;
      this.writeShapes(size);
    }
    if (size === "none") { for (const el of this.bigNames.values()) el.remove(); this.bigNames.clear(); }
    this.pickNearMouse();
  }

  /** The destination path, the pilot's system first (UpdateAutopilotJumpRoute): its lines drawn as the route. */
  setRoute(systemIDs: readonly number[]): void {
    if (!this.lineAttrs || !this.lineColours) return;
    const old = [...this.routeLines.keys()];
    this.routeLines.clear();
    const lineOf = new Map<string, number>();
    this.lineEnds.forEach(([a, b], i) => { lineOf.set(`${a}:${b}`, i); lineOf.set(`${b}:${a}`, i); });
    for (let k = 0; k + 1 < systemIDs.length; k++) {
      const i = lineOf.get(`${systemIDs[k]}:${systemIDs[k + 1]}`);
      if (i !== undefined) this.routeLines.set(i, systemIDs[k]!);
    }
    for (const i of new Set([...old, ...this.routeLines.keys()])) this.writeLine(i);
    this.updateLineOpacity();
  }

  /** A line's attributes: its own look, or the route's (ApplyJumpLineColorAndWidth, ChangeLineAnimation). */
  private writeLine(i: number): void {
    const look = this.lineLooks[i]!;
    const [a, b] = this.lineEnds[i]!;
    const from = this.routeLines.get(i);
    const dir = this.lineAttrs!.dir.array as Float32Array, anim = this.lineAttrs!.anim.array as Float32Array, ovl = this.lineAttrs!.ovl.array as Float32Array;
    const col = this.lineColours!.array as Float32Array;
    const secRgb = (id: number) => securityStatusRgb(this.security.get(id) ?? 0);
    const length = this.positions.get(a)!.distanceTo(this.positions.get(b)!);
    const scale = from !== undefined ? length / AUTOPILOT_LINE_TICKSIZE : look.scale;
    const speed = from !== undefined ? AUTOPILOT_LINE_ANIM_SPEED / scale * (from === a ? -1 : 1) : 0;
    const width = from !== undefined ? JUMPLINE_BASE_WIDTH * 2 : look.width;
    const overlay = from !== undefined ? [0, 0, 0, 0.75] : look.overlay;
    for (let k = 0; k < 6; k++) {
      const v = i * 6 + k;
      const end = k === 2 || k === 4 || k === 5 ? 1 : 0;
      const rgb = from !== undefined ? secRgb(end ? b : a) : look.rgb;
      col[v * 4] = rgb[0]!; col[v * 4 + 1] = rgb[1]!; col[v * 4 + 2] = rgb[2]!;
      dir[v * 4 + 3] = Math.sign(dir[v * 4 + 3]!) * width;
      anim[v * 2] = speed; anim[v * 2 + 1] = scale;
      ovl[v * 4] = overlay[0]!; ovl[v * 4 + 1] = overlay[1]!; ovl[v * 4 + 2] = overlay[2]!; ovl[v * 4 + 3] = overlay[3]!;
    }
    this.lineAttrs!.dir.needsUpdate = this.lineAttrs!.anim.needsUpdate = this.lineAttrs!.ovl.needsUpdate = true;
    this.lineColours!.needsUpdate = true;
  }

  /** LineOpacityFinder3D.GetLineOpacityByLineID, into each line's colour alpha (clamped as a UBYTE4N colour is). */
  private updateLineOpacity(): void {
    if (!this.lineColours || !this.data) return;
    const constellation = this.selectedID !== null ? this.within.get(this.selectedID)?.[1] ?? null : null;
    const inActive = (id: number) => constellation !== null && this.within.get(id)?.[1] === constellation;
    const arr = this.lineColours.array as Float32Array;
    if (this.abstract) {
      // LineOpacityFinderAbstract: per system, each of its lines + the opacity given
      const add = new Map<number, number>();
      const bySystem = new Map<number, number[]>();
      this.lineEnds.forEach(([a, b], i) => { for (const id of [a, b]) bySystem.set(id, [...(bySystem.get(id) ?? []), i]); });
      const give = (ids: Iterable<number>, opacity: number) => { for (const id of ids) for (const i of bySystem.get(id) ?? []) add.set(i, (add.get(i) ?? 0) + opacity); };
      const def = this.abstractDefault;
      const region = this.selectedID !== null ? this.within.get(this.selectedID)?.[0] ?? null : null;
      if (region !== null) {
        const inRegion = [...this.within].filter(([, w]) => w[0] === region).map(([id]) => id);
        const set = new Set(inRegion);
        const others = new Set<number>();
        for (const [a, b] of this.lineEnds) { if (set.has(a) && !set.has(b)) others.add(b); if (set.has(b) && !set.has(a)) others.add(a); }
        give([...inRegion, ...others], def);
      }
      if (this.hoverID !== null) give([this.hoverID], def);
      if (this.selectedID !== null) give([this.selectedID], 1.0);
      this.lineEnds.forEach((_, i) => {
        const opacity = this.routeLines.has(i) ? 2.0 : add.get(i) ?? def;
        for (let k = 0; k < 6; k++) arr[(i * 6 + k) * 4 + 3] = Math.min(1, opacity);
      });
      this.lineColours.needsUpdate = true;
      return;
    }
    this.lineEnds.forEach(([a, b], i) => {
      // each of the active constellation's systems adds to each of its lines (a line between two adds twice)
      const n = (inActive(a) ? 1 : 0) + (inActive(b) ? 1 : 0);
      // (a route line's colour is set after, at alpha 2.0)
      const opacity = this.routeLines.has(i) ? 2.0 : n ? n * 1.0 + (this.hoverID !== null ? n * 0.3 : 0) : LINE_OPACITY_DEFAULT;
      const alpha = Math.min(1, opacity);
      for (let k = 0; k < 6; k++) arr[(i * 6 + k) * 4 + 3] = alpha;
    });
    this.lineColours.needsUpdate = true;
  }

  /** The selected system's markers: its label and its active systems' (neighbours, constellation), "You are here". */
  private buildMarkers(data: StarMapSystems, within: Map<number, [number, number]>, names: Map<number, string>, systemID: number | null): void {
    this.markers.replaceChildren();
    this.labels = [];
    this.myLocation = null;
    if (systemID === null || !this.positions.has(systemID)) return;
    const constellation = within.get(systemID)?.[1];
    const active = new Set<number>([systemID]);
    for (const [a, b] of data.jumps) { if (a === systemID) active.add(b); if (b === systemID) active.add(a); }
    for (const [id, , , , , , c] of data.systems) if (c === constellation) active.add(id);
    for (const id of active) {
      const at = this.positions.get(id);
      if (!at) continue;
      const el = document.createElement("div");
      el.textContent = names.get(id) ?? "";
      el.style.cssText = "position:absolute;white-space:nowrap;font-size:10px;line-height:12px;font-weight:700;color:rgba(255,255,255,0.75);"
        + "font-family:'EVE Sans Neue','Barlow Semi Condensed','Segoe UI',sans-serif;";
      this.markers.appendChild(el);
      this.labels.push({ id, at, el, selected: id === systemID });
    }
    const hereAt = this.hereID !== null ? this.positions.get(this.hereID) : this.positions.get(systemID);
    if (!hereAt) return;
    const here = document.createElement("div");
    here.style.cssText = "position:absolute;width:14px;height:14px;";
    const bg = document.createElement("img");
    bg.src = "/client-res/ui/texture/classes/mapview/tagbackground.png";
    bg.style.cssText = "position:absolute;left:-25px;top:-13px;width:64px;height:64px;";
    const icon = document.createElement("img");
    icon.src = "/client-res/ui/texture/classes/mapview/focusicon.png";
    icon.style.cssText = "position:absolute;left:-1px;top:-1px;width:16px;height:16px;";
    here.title = "You are here";
    here.append(bg, icon);
    this.markers.appendChild(here);
    this.myLocation = { at: hereAt, el: here };
  }

  /** Each marker where its point projects (a bracket's place), its opacity as the client's. */
  private placeMarkers(w: number, h: number): void {
    const v = new THREE.Vector3();
    const project = (at: THREE.Vector3) => {
      v.copy(at).project(this.camera);
      return v.z < 1 && v.z > -1 ? { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h } : null;
    };
    const eye = this.camera.position;
    // the abstract markers' content: big - every on-screen system's name under its bubble; else only the selected's
    if (this.markerSize === "big" || this.markerSize === "medium") {
      const big = this.markerSize === "big";
      const content = (big ? 145.3 : 106.25) / 5000 * h;
      // the medium names' opacity by the zoom value (_GetMarkerSizeToUse)
      const faint = this.zoomValue > 0.71 ? 0 : 0.3 + ((this.zoomValue - 0.71) / (0.66 - 0.71)) * 0.45;
      const seen = new Set<number>();
      for (const [id, at] of this.positions) {
        if (!big && !this.preview.has(id)) continue;
        const p = project(at);
        if (!p || p.x < -100 || p.x > w + 100 || p.y < -100 || p.y > h + 100) continue;
        seen.add(id);
        let el = this.bigNames.get(id);
        if (!el) {
          el = document.createElement("div");
          el.textContent = this.names.get(id) ?? "";
          el.style.cssText = "position:absolute;white-space:nowrap;font-size:10px;line-height:12px;color:rgba(255,255,255,0.75);opacity:0.75;"
            + "font-family:'EVE Sans Neue','Barlow Semi Condensed','Segoe UI',sans-serif;transform-origin:0 0;";
          this.markers.appendChild(el);
          this.bigNames.set(id, el);
        }
        el.style.opacity = String(big || id === this.selectedID || id === this.hoverID ? 0.75 : faint);
        const width = el.offsetWidth;
        el.style.transform = `translate(${(p.x - width / 2).toFixed(1)}px, ${(p.y + (content + 12) / 2 + 3 - 6).toFixed(1)}px)`;
      }
      for (const [id, el] of this.bigNames) if (!seen.has(id)) { el.remove(); this.bigNames.delete(id); }
    }
    for (const l of this.labels) {
      const p = project(l.at);
      // (abstract: MARKER_NONE content shows a name only while selected or hilighted; big shows the names above)
      if (this.abstract && (!l.selected || this.markerSize === "big")) { l.el.style.display = "none"; continue; }
      const opacity = l.selected ? 1 : Math.max(0, Math.min(1, 1 - eye.distanceTo(l.at) / 17500));
      if (!p || opacity <= 0) { l.el.style.display = "none"; continue; }
      l.el.style.display = "";
      l.el.style.opacity = String(opacity);
      // CENTERLEFT: its text LABEL_LEFT (22 px) right of the point, centred on it
      l.el.style.transform = `translate(${(p.x + 22).toFixed(1)}px, ${(p.y - 6).toFixed(1)}px)`;
    }
    if (this.hoverLabel) {
      const p = project(this.hoverLabel.at);
      this.hoverLabel.el.style.display = p ? "" : "none";
      if (p) this.hoverLabel.el.style.transform = `translate(${(p.x - 7).toFixed(1)}px, ${(p.y - 7).toFixed(1)}px)`;
    }
    if (this.myLocation) {
      const p = project(this.myLocation.at);
      this.myLocation.el.style.display = p ? "" : "none";
      if (p) this.myLocation.el.style.transform = `translate(${(p.x - 7).toFixed(1)}px, ${(p.y - 7 - 30).toFixed(1)}px)`;
    }
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
    this.stepLayout(performance.now());
    // Make2DCamera's turn: pitch to kMinPitch (0.005 from straight down) and yaw to 0 over 1 s, the distance kept
    if (this.turn) {
      const t = Math.min(1, (performance.now() - this.turn.at) / 1000);
      const d = Math.min(310000, Math.max(3100, this.turn.from.length()));
      // yaw 0 with the default eye's way: from above, behind on EVE's -z (three's +z)
      const top = new THREE.Vector3(0, Math.cos(0.005), Math.sin(0.005)).multiplyScalar(d);
      const now = this.turn.from.clone().normalize().lerp(top.clone().normalize(), t).normalize().multiplyScalar(this.turn.from.length() + (d - this.turn.from.length()) * t);
      this.camera.position.copy(this.controls.target).add(now);
      if (t >= 1) this.turn = null;
    }
    // the abstract default opacity and the sprite values by the zoom value (MAP2D_ZOOM_TUBE_BUBBLE, _TUBE_MARKER)
    let kind: "none" | "medium" | "big" = "none";
    if (this.abstract && !this.morph) {
      const d = this.camera.position.distanceTo(this.controls.target);
      const zoom = Math.min(1, Math.max(0, (d - 3100) / (310000 - 3100))) ** (1 / 9);
      const def = zoom < 0.75 ? 0.4 : 0.3;
      if (def !== this.abstractDefault) { this.abstractDefault = def; this.updateLineOpacity(); }
      kind = zoom < 0.66 ? "big" : zoom < 0.75 ? "medium" : "none";
      this.zoomValue = zoom;
    }
    if (kind !== this.markerSize || (kind !== "none" && this.shapesFor !== this.selectedID)) this.applySpriteValues(kind);
    // the move to a newly selected system: the point of interest and the eye together, over half a second
    if (this.move) {
      const t = Math.min(1, (performance.now() - this.move.at) / 500);
      const k = t * t * (3 - 2 * t);
      const target = this.move.from.clone().lerp(this.move.to, k);
      this.camera.position.add(target.clone().sub(this.controls.target));
      this.controls.target.copy(target);
      if (t >= 1) this.move = null;
    }
    this.controls.update();
    // OnCameraUpdate: the far clip the camera's distance and the universe's size; the distance ranges
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = 0.1;
    this.camera.far = distance + 40000;
    this.camera.updateProjectionMatrix();
    const fadeOutFar = Math.max(100, distance * 4);
    this.starUniforms.distanceRange.value.set(distance, fadeOutFar);
    if (this.abstract) this.lineUniforms.distanceRange.value.set(310000, 310000 * 10000);
    else this.lineUniforms.distanceRange.value.set(distance, fadeOutFar * 100);
    this.lineUniforms.targetResolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.lineUniforms.time.value = performance.now() / 1000;
    this.renderer.render(this.scene, this.camera);
    this.placeMarkers(w, h);
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
