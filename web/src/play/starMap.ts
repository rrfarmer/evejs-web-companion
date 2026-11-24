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
// - the region and constellation names (mapView LoadRegionMarkers / LoadConstellationMarkers; markers/mapMarkerRegion.py,
//   mapMarkerContellation.py), at the region's / constellation's own centre, or in the abstract layout the average of
//   its systems' abstract places on the plane (GetRegionCorrdinates' overridden region average,
//   GetPosForConstellationMarker): a region's MarkerLabelRegion - its name in capitals, 10 px, letter spacing 3,
//   (1, 1, 1, 0.85), 20 px above its point - at OPACITY_MARKER_SELECTED (1.3) while active (the selected system's),
//   else GetMarkerBaseOpacity(d, MAX_MARKER_DISTANCE x 0.015, x 2) x GetNearFadeFactor (min(1, zoom distance / d)),
//   rounded to 2; a constellation's MarkerLabelConstellation - shown only active (the selected system's region's
//   constellations) or selected (its own): a Label at 0.95 in a box (Frame 0.3, Fill (0, 0, 0, 0.5)), 8 px above
//   its point, "name <colour>security" (the systems' mean, FmtSystemSecStatus) unless selected; 3D: selected 1.3,
//   active GetMarkerBaseOpacity(d, x 0.07, x 0.3) x the near factor; abstract (_GetMarkerOpacity_Abstract): 0.6
//   between MAP2D_ZOOM_TUBE_BUBBLE 0.75 and MAP2D_ZOOM_CONSTELLATION_NAME_MAX 0.81, else nothing, 20 px lower.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadDds } from "../three/ddsTexture.ts";
import { logDepth } from "../three/logDepth.ts";
import { securityStatusColor, securityStatusRgb, shownSecurity } from "../bridge/systemSecurity.ts";
import type { StarMapActivity, StarMapColorMode } from "../bridge/starMapFilters.ts";
import { activityClusterCentroid, groupActivityPins, mapZoomValue, type ActivityCluster, type ActivityPin } from "./starMapActivityGroups.ts";

/** mapViewConst.py */
const UNIVERSE_SCALE = 1.5e-13;
const MIN_CAMERA_DISTANCE = 1.0;
const MAX_CAMERA_DISTANCE = 160000.0;
/** mapView.py ZOOM_DIST_SYSTEM: the distance the map opens at on a system. */
const ZOOM_DIST_SYSTEM = 6000;
const ZOOM_DIST_CONSTELLATION = 10000;
const ZOOM_DIST_REGION = 20000;
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
const ORE_PROJECTED = rgb("305665");
const ORE_PRECISE = rgb("58a7bf");
const PHASED = rgb("f8faa6");
const CONVOY_STAR = rgb("ffffff");
const CONVOY_LINE = rgb("956bec");
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
  /**
   * The camera as the mirrored canvas shows it (spaceView's HANDEDNESS: the client draws right-handed, EVE's z is
   * mirrored into three's, so the canvas is shown mirrored left to right): its screen x mirrored.
   */
  private readonly mirrorCam = new THREE.PerspectiveCamera();
  private get screenCam(): THREE.PerspectiveCamera {
    const c = this.camera, m = this.mirrorCam;
    m.matrixWorld.copy(c.matrixWorld);
    m.matrixWorldInverse.copy(c.matrixWorldInverse);
    m.projectionMatrix.copy(c.projectionMatrix);
    const e = m.projectionMatrix.elements;
    e[0] = -e[0]!; e[4] = -e[4]!; e[8] = -e[8]!; e[12] = -e[12]!;
    m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
    return m;
  }
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
  private convoyTex: THREE.Texture | null = null;
  private closed = false;
  private shapes: THREE.InstancedBufferAttribute | null = null;
  private extraMesh: THREE.Mesh | null = null;
  /** The marker size type the abstract sprites are at (MARKER_NONE / MEDIUM / BIG), and the big markers' names. */
  markerSize: "none" | "medium" | "big" = "none";
  /** The mouse over the map (page coordinates), and the preview bubbles' systems (previewBubbleMarkerIDs). */
  private mouse: { x: number; y: number } | null = null;
  preview = new Set<number>();
  private zoomValue = 1;
  private bigNames = new Map<number, HTMLDivElement>();
  /** The region and constellation names: each one's places in the two layouts and its element. */
  private regionMarks: { id: number; own: THREE.Vector3; abstract: THREE.Vector3; el: HTMLDivElement }[] = [];
  private constellationMarks: { id: number; regionID: number; own: THREE.Vector3; abstract: THREE.Vector3; el: HTMLDivElement; name: string; security: number | null }[] = [];
  private readonly positions = new Map<number, THREE.Vector3>();
  /** Each system's place in the two layouts, and the stars' position attribute. */
  private readonly layouts = { own: new Map<number, THREE.Vector3>(), abstract: new Map<number, THREE.Vector3>() };
  private readonly abstractUrl: Promise<string | null>;
  private layoutRequest = 0;
  private starPos: THREE.InstancedBufferAttribute | null = null;
  private starColors: THREE.InstancedBufferAttribute | null = null;
  private starSizes: THREE.InstancedBufferAttribute | null = null;
  private colorMode: StarMapColorMode = "empire";
  private readonly activity = new Map<number, StarMapActivity>();
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
  private readonly activityMarkers = document.createElement("div");
  private activityLabels: { row: StarMapActivity; button: HTMLButtonElement }[] = [];
  private activityPins: ActivityPin[] = [];
  private readonly activityClusters = new Map<number, { cluster: ActivityCluster; button: HTMLButtonElement }>();
  private activityClusterHint = (value: number) => String(value);
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
  private homeID: number | null = null;
  private locationHint = "You are here";
  selectedID: number | null = null;
  private selectedCluster: ActivityCluster | null = null;
  hoverID: number | null = null;
  private hoverLabel: { el: HTMLDivElement; at: THREE.Vector3 } | null = null;
  /** The camera's move to a newly selected system: from where, to where, since when. */
  private move: { from: THREE.Vector3; to: THREE.Vector3; at: number; zoom?: { from: number; to: number } } | null = null;
  private myLocation: { at: THREE.Vector3; el: HTMLDivElement } | null = null;
  /** How many stars and jump lines are drawn (for checks). */
  stars = 0;
  jumps = 0;

  constructor() {
    this.root.className = "star-map";
    this.root.dataset.layout = "perspective";
    this.root.style.cssText = "position:absolute;inset:0;background:#000;z-index:5;";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.root.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block;transform:scaleX(-1);";
    this.markers.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    this.root.appendChild(this.markers);
    this.activityMarkers.className = "star-map-activity-markers";
    this.root.appendChild(this.activityMarkers);
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
    // the mirrored canvas: a sideways drag keeps its sense on screen
    {
      const controls = this.controls as unknown as { _rotateLeft(angle: number): void; _panLeft(distance: number, matrix: THREE.Matrix4): void };
      const rotateLeft = controls._rotateLeft.bind(controls);
      controls._rotateLeft = (angle: number) => rotateLeft(-angle);
      const panLeft = controls._panLeft.bind(controls);
      controls._panLeft = (distance: number, matrix: THREE.Matrix4) => panLeft(-distance, matrix);
    }
    this.controls.minDistance = MIN_CAMERA_DISTANCE;
    this.controls.maxDistance = MAX_CAMERA_DISTANCE;
    this.controls.enableDamping = true;
    // (mapStarNew5.dds and mapStarNewHeat.dds are one uncompressed level each: a mipmapped filter samples black)
    const level = async (url: string) => {
      const t = await loadDds(url);
      if (!t.mipmaps?.length) { t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; }
      return t;
    };
    const assets = fetch("/client-assets/starmap.json").then((r) => r.json() as Promise<{
      textures?: Record<string, string | null>; abstract?: string | null;
    }>);
    this.abstractUrl = assets.then(m => m.abstract ?? null, () => null);
    void assets.then(async m => {
      if (m.textures?.star) { this.starUniforms.texMap.value = await level(m.textures.star); this.starUniforms.hasTex.value = 1; }
      if (m.textures?.heat) { this.heatTex = await level(m.textures.heat); this.updateFilterHeat(); }
      if (m.textures?.tube) this.tubeTex = await level(m.textures.tube);
      if (m.textures?.iconAtlas) { const t = await level(m.textures.iconAtlas); this.bubbleUniforms.iconAtlas.value = t; this.bubbleUniforms.hasAtlas.value = 1; }
      if (m.textures?.extra) { this.extraUniforms.heat.value = await level(m.textures.extra); this.extraUniforms.hasHeat.value = 1; }
      if (m.textures?.line && m.textures?.lineOverlay) {
        const [line, overlay] = await Promise.all([level(m.textures.line), level(m.textures.lineOverlay)]);
        // (the samplers wrap: EveSpaceSceneEnvMapSampler's address wrap, wrap)
        for (const t of [line, overlay]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
        this.lineUniforms.texMap.value = line; this.lineUniforms.overlayTexMap.value = overlay; this.lineUniforms.hasTex.value = 1;
      }
      if (m.textures?.convoys) {
        const texture = await level(m.textures.convoys);
        if (this.closed) texture.dispose();
        else { this.convoyTex = texture; this.updateFilterHeat(); }
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
    this.starColors = new THREE.InstancedBufferAttribute(new Float32Array(iColour), 3);
    this.starSizes = new THREE.InstancedBufferAttribute(new Float32Array(iSize), 1);
    geometry.setAttribute("iColour", this.starColors);
    geometry.setAttribute("iSize", this.starSizes);
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
    this.updateMyLocation();
    this.buildAreaMarkers(data as StarMapSystems & { regions?: readonly (readonly [number, number, number, number, string])[]; constellations?: readonly (readonly [number, number, number, number, string, number])[] });
    this.selectedID = focusSystemID;
    this.updateLineOpacity();
    this.focus(focusSystemID);
  }

  /** The region and constellation markers, their places in both layouts (the abstract one once it is read). */
  private buildAreaMarkers(data: StarMapSystems & { regions?: readonly (readonly [number, number, number, number, string])[]; constellations?: readonly (readonly [number, number, number, number, string, number])[] }): void {
    const style = "position:absolute;white-space:nowrap;font-family:'EVE Sans Neue','Barlow Semi Condensed','Segoe UI',sans-serif;";
    for (const [id, x, y, z, name] of data.regions ?? []) {
      this.names.set(id, name);
      const el = document.createElement("div");
      el.textContent = name.toUpperCase();
      el.style.cssText = style + "font-size:10px;line-height:12px;font-weight:700;letter-spacing:3px;color:rgba(255,255,255,0.85);";
      this.markers.appendChild(el);
      this.regionMarks.push({ id, own: mapPosition(x, y, z), abstract: mapPosition(x, y, z).setY(0), el });
    }
    const secBy = new Map<number, number[]>();
    for (const s of data.systems) { if (typeof s[8] === "number") secBy.set(s[6], [...(secBy.get(s[6]) ?? []), s[8]]); }
    for (const [id, x, y, z, name, regionID] of data.constellations ?? []) {
      this.names.set(id, name);
      const el = document.createElement("div");
      el.style.cssText = style + "font-size:12px;line-height:14px;padding:0 3px;color:rgba(255,255,255,0.95);background:rgba(0,0,0,0.5);"
        + "outline:1px solid rgba(255,255,255,0.3);display:none;";
      this.markers.appendChild(el);
      const secs = secBy.get(id) ?? [];
      this.constellationMarks.push({ id, regionID, own: mapPosition(x, y, z), abstract: mapPosition(x, y, z).setY(0), el, name, security: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null });
    }
  }

  /** The abstract places of the regions and constellations: the means of their systems' abstract places. */
  private placeAreasAbstract(): void {
    const sums = new Map<number, [number, number, number]>();
    const add = (key: number, p: THREE.Vector3) => { const s = sums.get(key) ?? [0, 0, 0]; s[0] += p.x; s[1] += p.z; s[2]++; sums.set(key, s); };
    for (const [id, p] of this.layouts.abstract) { const w = this.within.get(id); if (!w) continue; add(w[0], p); add(w[1], p); }
    for (const m of [...this.regionMarks, ...this.constellationMarks]) {
      const s = sums.get(m.id);
      if (s && s[2]) m.abstract.set(s[0] / s[2], 0, s[1] / s[2]);
    }
  }

  /** The nearest star within 8 px of a point on the page, or null. */
  starAt(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const v = new THREE.Vector3();
    let best: number | null = null, bestD = 8;
    for (const [id, p] of this.positions) {
      v.copy(p).project(this.screenCam);
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
    this.selectedCluster = null;
    this.buildMarkers(this.data, this.within, this.names, systemID);
    this.updateLineOpacity();
    this.move = { from: this.controls.target.clone(), to: this.positions.get(systemID)!.clone(), at: performance.now() };
  }

  private get selectedRegionID(): number | null {
    return this.selectedCluster?.regionID ?? (this.selectedID === null ? null : this.within.get(this.selectedID)?.[0] ?? null);
  }

  private get selectedConstellationID(): number | null {
    if (this.selectedCluster) return this.selectedCluster.level === "constellation" ? this.selectedCluster.id : null;
    return this.selectedID === null ? null : this.within.get(this.selectedID)?.[1] ?? null;
  }

  private clusterPosition(cluster: ActivityCluster): THREE.Vector3 {
    const { x, y, z } = activityClusterCentroid(cluster.members);
    return new THREE.Vector3(x, y, z);
  }

  private selectActivityCluster(cluster: ActivityCluster): void {
    if (!this.data) return;
    this.selectedID = cluster.id;
    this.selectedCluster = cluster;
    this.buildMarkers(this.data, this.within, this.names, null, this.selectedConstellationID);
    this.updateLineOpacity();
    const target = this.controls.target;
    this.move = {
      from: target.clone(), to: this.clusterPosition(cluster), at: performance.now(),
      zoom: { from: this.camera.position.distanceTo(target), to: cluster.level === "region" ? ZOOM_DIST_REGION : ZOOM_DIST_CONSTELLATION },
    };
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
    const request = ++this.layoutRequest;
    if (!this.data) return;
    if (abstract && this.layouts.abstract.size === 0) {
      const url = await this.abstractUrl;
      if (!url || request !== this.layoutRequest || this.closed) return;
      const coords = await fetch(url).then((r) => r.json() as Promise<Record<string, [number, number]>>).catch(error => {
        console.warn("star map abstract layout", error);
        return null;
      });
      if (!coords || request !== this.layoutRequest || this.closed) return;
      for (const [id, own] of this.layouts.own) {
        const c = coords[String(id)];
        this.layouts.abstract.set(id, c ? mapPosition(c[0], 0, c[1]) : own.clone());
      }
      this.placeAreasAbstract();
    }
    this.abstract = abstract;
    this.root.dataset.layout = abstract ? "abstract" : "perspective";
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
      this.controls.screenSpacePanning = true;
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
    const selectedPosition = () => this.selectedCluster ? this.clusterPosition(this.selectedCluster)
      : this.selectedID !== null ? this.positions.get(this.selectedID) : undefined;
    const sel = selectedPosition()?.clone();
    for (const [id, p] of this.positions) p.lerpVectors(this.morph.from.get(id)!, target.get(id)!, t);
    if (sel && !this.move) {
      const delta = selectedPosition()!.clone().sub(sel);
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
          v.copy(p).project(this.screenCam);
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
      this.updateFilterHeat();
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

  private updateFilterHeat(): void {
    if (this.markerSize !== "none") return;
    const texture = this.colorMode === "convoys" ? this.convoyTex ?? this.heatTex : this.heatTex;
    this.bubbleUniforms.heat.value = texture;
    this.bubbleUniforms.hasHeat.value = texture ? 1 : 0;
  }

  private activityColor(systemID: number, line = false): [number, number, number] {
    const row = this.activity.get(systemID);
    if (!row) return NEUTRAL;
    if (this.colorMode === "ore") return row.dungeonNameIDs ? ORE_PRECISE : ORE_PROJECTED;
    if (this.colorMode === "phased") return PHASED;
    return line ? CONVOY_LINE : CONVOY_STAR;
  }

  setColorMode(mode: StarMapColorMode, rows: readonly StarMapActivity[] = [], homeSystemID: number | null = null): void {
    if (!this.data || !this.starColors || !this.starSizes) return;
    this.colorMode = mode;
    this.homeID = homeSystemID;
    this.activity.clear();
    for (const row of rows) {
      if (this.positions.has(row.systemID)) this.activity.set(row.systemID, row);
    }
    const colors = this.starColors, sizes = this.starSizes;
    this.data.systems.forEach(([id, , , , factionID], i) => {
      const [r, g, b] = mode === "empire" ? starColour(factionID) : this.activityColor(id);
      const affected = mode === "empire" ? factionID !== 0 : this.activity.has(id);
      colors.setXYZ(i, r, g, b);
      sizes.setX(i, affected ? (mode === "convoys" ? 120 : STAR_SIZE_FACTION) : STAR_SIZE_UNIMPORTANT);
    });
    colors.needsUpdate = sizes.needsUpdate = true;
    this.lineEnds.forEach((_, i) => this.writeLine(i));
    this.updateLineOpacity();
    this.updateFilterHeat();
    this.activityLabels = [];
    this.activityPins = [];
    this.activityClusters.clear();
    if (mode !== "empire") for (const row of this.activity.values()) {
      const button = document.createElement("button");
      button.className = "star-map-activity-marker";
      button.dataset.systemId = String(row.systemID);
      button.dataset.kind = mode === "ore" ? (row.dungeonNameIDs ? "precise" : "projected") : mode;
      if (mode === "phased") {
        const icon = document.createElement("img");
        icon.src = "/client-res/ui/texture/eveicon/control_icons/phased_site_32px.png";
        icon.alt = "";
        button.appendChild(icon);
      } else button.textContent = String(row.count);
      button.onclick = () => this.select(row.systemID);
      this.activityLabels.push({ row, button });
      const [regionID, constellationID] = this.within.get(row.systemID) ?? [0, 0];
      this.activityPins.push({ systemID: row.systemID, sites: row.count, regionID, constellationID, position: this.positions.get(row.systemID)! });
    }
    this.markLocalActivities();
    this.activityMarkers.replaceChildren(...this.activityLabels.map(({ button }) => button));
  }

  private markLocalActivities(): void {
    for (const { row, button } of this.activityLabels) {
      if (row.systemID === this.hereID || row.systemID === this.homeID) button.dataset.local = "true";
      else delete button.dataset.local;
    }
  }

  /** OnSessionChanged follows the new system only when the previous one was active. */
  setPilotSystem(systemID: number | null): void {
    if (systemID === this.hereID) return;
    const follow = this.selectedID === this.hereID;
    this.hereID = systemID;
    if (follow && systemID !== null) this.select(systemID);
    this.updateMyLocation();
    this.markLocalActivities();
  }

  setLocationHint(text: string): void {
    this.locationHint = text;
    if (this.myLocation) this.myLocation.el.title = text;
  }

  setActivityHints(hint: (row: StarMapActivity) => string, clusterHint: (value: number) => string): void {
    this.activityClusterHint = clusterHint;
    for (const { row, button } of this.activityLabels) {
      const system = this.names.get(row.systemID) || String(row.systemID);
      const detail = hint(row);
      button.title = detail ? `${system}\n${detail}` : system;
      button.setAttribute("aria-label", button.title);
    }
    for (const { cluster, button } of this.activityClusters.values()) this.labelActivityCluster(cluster, button);
  }

  private labelActivityCluster(cluster: ActivityCluster, button: HTMLButtonElement): void {
    const name = this.names.get(cluster.id) ?? "";
    const hint = this.activityClusterHint(cluster.value);
    button.title = name ? `${name}\n${hint}` : hint;
    button.setAttribute("aria-label", button.title);
    button.textContent = String(cluster.value);
    button.dataset.memberCount = String(cluster.members.length);
  }

  private placeActivityMarkers(project: (at: THREE.Vector3) => { x: number; y: number } | null, w: number, h: number): void {
    if (this.colorMode === "empire") return;
    const eye = this.camera.position;
    const cameraDistance = eye.distanceTo(this.controls.target);
    const zoom = mapZoomValue(cameraDistance, this.controls.minDistance, this.controls.maxDistance);
    const groups = groupActivityPins(this.activityPins, this.colorMode, zoom, this.abstract, eye);
    const inGroup = new Set<number>();
    const seen = new Set<number>();
    for (const cluster of groups) {
      seen.add(cluster.id);
      for (const pin of cluster.members) inGroup.add(pin.systemID);
      let marker = this.activityClusters.get(cluster.id);
      if (!marker) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "star-map-activity-cluster";
        button.dataset.areaId = String(cluster.id);
        button.dataset.level = cluster.level;
        const entry = { cluster, button };
        button.onclick = () => this.selectActivityCluster(entry.cluster);
        this.labelActivityCluster(cluster, button);
        this.activityMarkers.appendChild(button);
        this.activityClusters.set(cluster.id, entry);
        marker = entry;
      } else if (marker.cluster.value !== cluster.value || marker.cluster.members.length !== cluster.members.length) {
        this.labelActivityCluster(cluster, marker.button);
      }
      marker.cluster = cluster;
      const at = this.clusterPosition(cluster);
      const p = project(at);
      const d = eye.distanceTo(at);
      // MarkerGroup's perspective fade uses MAX_MARKER_DISTANCE * (0.015, 2).
      const opacity = this.abstract || cluster.id === this.selectedID ? 1
        : Math.round((d < 3300 ? d / 3300 : Math.max(0, 1 - d / 440000)) * Math.min(1, cameraDistance / d) * 100) / 100;
      marker.button.hidden = !p || p.x < 0 || p.x > w || p.y < 0 || p.y > h || opacity <= 0.05;
      if (p && !marker.button.hidden) {
        marker.button.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
        marker.button.style.opacity = String(opacity);
      }
    }
    for (const [id, marker] of this.activityClusters) {
      if (seen.has(id)) continue;
      marker.button.remove();
      this.activityClusters.delete(id);
    }
    for (const { row, button } of this.activityLabels) {
      if (inGroup.has(row.systemID)) {
        button.hidden = true;
        continue;
      }
      const p = project(this.positions.get(row.systemID)!);
      button.hidden = !p || p.x < 0 || p.x > w || p.y < 0 || p.y > h;
      if (p && !button.hidden) {
        // MarkerPinBase.SetUpsideDown moves markers beside the location pin below the star.
        const offset = button.dataset.local === "true" ? "25px" : "-130%";
        button.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, ${offset})`;
      }
    }
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
      const id = end ? b : a;
      const rgb = from !== undefined ? secRgb(id) : this.colorMode === "empire" ? look.rgb : this.activityColor(id, true);
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
    const constellation = this.selectedConstellationID;
    const inActive = (id: number) => constellation !== null && this.within.get(id)?.[1] === constellation;
    const arr = this.lineColours.array as Float32Array;
    if (this.abstract) {
      // LineOpacityFinderAbstract: per system, each of its lines + the opacity given
      const add = new Map<number, number>();
      const bySystem = new Map<number, number[]>();
      this.lineEnds.forEach(([a, b], i) => { for (const id of [a, b]) bySystem.set(id, [...(bySystem.get(id) ?? []), i]); });
      const give = (ids: Iterable<number>, opacity: number) => { for (const id of ids) for (const i of bySystem.get(id) ?? []) add.set(i, (add.get(i) ?? 0) + opacity); };
      const def = this.abstractDefault;
      const region = this.selectedRegionID;
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

  /** The selected system's label and its neighbours and constellation. */
  private buildMarkers(data: StarMapSystems, within: Map<number, [number, number]>, names: Map<number, string>, systemID: number | null,
    constellation = systemID === null ? null : within.get(systemID)?.[1] ?? null): void {
    for (const { el } of this.labels) el.remove();
    this.labels = [];
    const active = new Set<number>();
    if (systemID !== null && this.positions.has(systemID)) {
      active.add(systemID);
      for (const [a, b] of data.jumps) { if (a === systemID) active.add(b); if (b === systemID) active.add(a); }
    }
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
  }

  private updateMyLocation(): void {
    const hereAt = this.hereID === null ? null : this.positions.get(this.hereID);
    if (!hereAt) {
      this.myLocation?.el.remove();
      this.myLocation = null;
      return;
    }
    if (this.myLocation) {
      this.myLocation.at = hereAt;
      this.myLocation.el.dataset.systemId = String(this.hereID);
      return;
    }
    const here = document.createElement("div");
    here.className = "star-map-my-location";
    here.dataset.systemId = String(this.hereID);
    here.style.cssText = "position:absolute;width:14px;height:14px;";
    // MarkerMyLocation.ConstructCircles creates three centered, noninteractive sprites.
    for (let i = 0; i < 3; ++i) {
      const pulse = document.createElement("span");
      pulse.className = "star-map-location-pulse";
      pulse.setAttribute("aria-hidden", "true");
      here.appendChild(pulse);
    }
    const bg = document.createElement("img");
    bg.src = "/client-res/ui/texture/classes/mapview/tagbackground.png";
    bg.alt = "";
    bg.style.cssText = "position:absolute;left:-25px;top:-13px;width:64px;height:64px;";
    const icon = document.createElement("img");
    icon.src = "/client-res/ui/texture/classes/mapview/focusicon.png";
    icon.alt = "";
    icon.style.cssText = "position:absolute;left:-1px;top:-1px;width:16px;height:16px;";
    here.title = this.locationHint;
    here.append(bg, icon);
    this.markers.appendChild(here);
    this.myLocation = { at: hereAt, el: here };
  }

  /** Each marker where its point projects (a bracket's place), its opacity as the client's. */
  private placeMarkers(w: number, h: number): void {
    const v = new THREE.Vector3();
    const project = (at: THREE.Vector3) => {
      v.copy(at).project(this.screenCam);
      return v.z < 1 && v.z > -1 ? { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h } : null;
    };
    const eye = this.camera.position;
    this.placeActivityMarkers(project, w, h);
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
    // the region and constellation names (their marker opacities; a layout change hides them, _mapTransitioning)
    const zoomDist = this.camera.position.distanceTo(this.controls.target);
    const base = (d: number, near: number, far: number) => (d < near ? d / near : d < far ? Math.min(1, Math.max(0, 1 - d / far)) : 0);
    const selRegion = this.selectedRegionID;
    const selConstellation = this.selectedConstellationID;
    for (const r of this.regionMarks) {
      const at = this.abstract ? r.abstract : r.own;
      const p = this.morph ? null : project(at);
      const d = eye.distanceTo(at);
      const opacity = r.id === selRegion ? 1 : Math.round(base(d, 220000 * 0.015, 220000 * 2) * Math.min(1, zoomDist / d) * 100) / 100;
      if (!p || opacity <= 0) { r.el.style.display = "none"; continue; }
      r.el.style.display = "";
      r.el.style.opacity = String(Math.min(1, opacity));
      r.el.style.transform = `translate(calc(${p.x.toFixed(1)}px - 50%), ${(p.y - 12 - 20).toFixed(1)}px)`;
    }
    for (const c of this.constellationMarks) {
      const selected = c.id === selConstellation, active = c.regionID === selRegion;
      let opacity = 0;
      if (selected || active) {
        if (this.abstract) opacity = this.zoomValue > 0.75 && this.zoomValue <= 0.81 ? 0.6 : 0;
        else {
          const d = eye.distanceTo(c.own);
          opacity = selected ? 1 : base(d, 220000 * 0.07, 220000 * 0.3) * Math.min(1, zoomDist / d);
        }
      }
      const at = this.abstract ? c.abstract : c.own;
      const p = this.morph || opacity <= 0 ? null : project(at);
      if (!p) { c.el.style.display = "none"; continue; }
      if (!c.el.childNodes.length || c.el.dataset.selected !== String(selected)) {
        c.el.dataset.selected = String(selected);
        c.el.replaceChildren(document.createTextNode(c.name));
        if (!selected && c.security !== null) {
          const s = document.createElement("span");
          s.textContent = " " + shownSecurity(c.security).toFixed(1);
          s.style.color = securityStatusColor(c.security);
          c.el.appendChild(s);
        }
      }
      c.el.style.display = "";
      c.el.style.opacity = String(Math.min(1, opacity));
      // offsetY: 3D -(height + 8), abstract -(height - 20)
      c.el.style.transform = `translate(calc(${p.x.toFixed(1)}px - 50%), ${(p.y - 14 - (this.abstract ? -20 : 8)).toFixed(1)}px)`;
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
      const zoom = mapZoomValue(d, 3100, 310000);
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
      const zoom = this.move.zoom;
      if (zoom) this.camera.position.sub(target).setLength(zoom.from + (zoom.to - zoom.from) * k).add(target);
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
    this.closed = true;
    this.stop();
    this.convoyTex?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
