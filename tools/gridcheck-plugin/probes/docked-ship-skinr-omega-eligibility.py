from carbonui.primitives.container import Container
from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from eve.client.script.ui.cosmetics.ship.pages.studio import studioDesignerPage
from localization import GetByLabel
from omega.client.clone_grade_svc import get_clone_grade_svc

clone_service = get_clone_grade_svc()


class GradeView(object):

    def can_sequence_for_hull(self, hull):
        return not clone_service.is_requirements_restricted(hull, grade)


original_service = studioDesignerPage.get_ship_skin_sequencing_svc
original_design = current_skin_design.get
parent = Container()
button = studioDesignerPage.CreateSKINButton(parent=parent)
samples = []
try:
    studioDesignerPage.get_ship_skin_sequencing_svc = GradeView
    current_skin_design.get = lambda: design
    for grade in (0, 1):
        for hull in (32880, 42244):
            design = SkinDesign()
            design.ship_type_id = hull
            design.fit_slot(1, 53)
            button.update()
            samples.append(dict(grade=grade, hull=hull, enabled=bool(button.enabled),
                                omegaBlocked=button.error_state == studioDesignerPage.CreateButtonErrorState.OMEGA_BLOCKED))
finally:
    current_skin_design.get = original_design
    studioDesignerPage.get_ship_skin_sequencing_svc = original_service
    sm.UnregisterNotify(button)
    parent.Close()

result = dict(station=session.stationid, samples=samples,
              hint=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/CannotSequenceForHullOmega'))
