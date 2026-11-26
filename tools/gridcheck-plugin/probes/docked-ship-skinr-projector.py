import evegraphics.utils as gfxutils
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from eve.client.script.ui.cosmetics.ship.pages.studio import gizmoControls
from localization import GetByLabel

design = SkinDesign(session.charid)
design.ship_type_id = 32880
pattern = design.fit_slot(5, 179)
model = sm.GetService('sofService').spaceObjectFactory.BuildFromDNA(gfxutils.BuildSOFDNAFromTypeID(32880))
pattern.ellipsoid_center = model.shapeEllipsoidCenter
pattern.ellipsoid_radii = model.shapeEllipsoidRadius
pattern.yaw = 0.3
pattern.pitch = 0.55
pattern.roll = 0.2
pattern.offset_u_ratio = 0.25
pattern.offset_v_ratio = -0.18
pattern.scaling_ratio = 0.64
pattern.projection_area2 = False
pattern.mirrored = True
transform = dict(position=list(pattern.position), rotation=list(pattern.rotation), scaling=list(pattern.scaling))
pattern.reset_rotation_scale_and_offset()
prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
result = dict(station=session.stationid, ship=design.ship_type_id, transform=transform,
              presets=[list(gizmoControls.DEFAULT_TOP_DOWN_VIEW), list(gizmoControls.DEFAULT_FRONTAL_VIEW),
                       list(gizmoControls.DEFAULT_SIDE_RIGHT_VIEW)],
              groups=[GetByLabel(prefix + 'Gizmo/' + key) for key in
                      ('OrbitalPanelButton', 'OffsetPanelButton', 'RotateScalePanelButton')],
              areas=[GetByLabel(prefix + key) for key in ('PrimaryArea', 'SecondaryArea', 'DetailingArea', 'TechArea')],
              mirror=GetByLabel(prefix + 'Gizmo/MirrorToggle'), reset=GetByLabel(prefix + 'ResetPatternProjection'),
              retainedAreas=pattern.get_projection_areas(), retainedMirror=pattern.mirrored,
              resetControls=[pattern.yaw, pattern.pitch, pattern.roll, pattern.offset_u_ratio, pattern.offset_v_ratio, pattern.scaling_ratio])
