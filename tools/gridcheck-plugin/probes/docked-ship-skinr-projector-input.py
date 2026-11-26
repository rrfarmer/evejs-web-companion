from eve.client.script.ui.camera.skinrShipSceneContainerCamera import SkinrShipSceneContainerCamera
from eve.client.script.ui.cosmetics.ship.pages.studio import gizmoControls
from localization import GetByLabel

classes = (gizmoControls.PatternAttributeSliderContainerYaw, gizmoControls.PatternAttributeSliderContainerPitch,
           gizmoControls.PatternAttributeSliderContainerRoll, gizmoControls.PatternAttributeSliderContainerOffsetU,
           gizmoControls.PatternAttributeSliderContainerOffsetV, gizmoControls.PatternAttributeSliderContainerScaling)
readable = (240.0, 30.0, 36.0, 25.0, -18.0, 1.28)
fields = []
for slider, value in zip(classes, readable):
    to_display = slider.value_to_readable_value.im_func
    to_ratio = slider.readable_value_to_value.im_func
    fields.append(dict(readable=value, ratio=to_ratio(slider, value), digits=slider.decimal_places,
                       minimum=to_display(slider, slider.min_value), maximum=to_display(slider, slider.max_value)))
camera = SkinrShipSceneContainerCamera
fixture = type('Fixture', (object,), dict(roll_snap_angles=camera.roll_snap_angles,
                                         roll_snap_delay=camera.roll_snap_delay, roll_snap_timestamp=long(0)))()
snap = camera.get_roll_snap_value.im_func(fixture, 0.0, 0.12) * 180
prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/Gizmo/'
result = dict(station=session.stationid, fields=fields, snap=snap, snapDelay=camera.roll_snap_delay,
              shortcuts=[GetByLabel(prefix + key) for key in ('OrbitPatternProjector', 'OffsetPatternProjector',
                                                             'RotatePatternProjector', 'ScalePattern', 'PrecisionMode')])
