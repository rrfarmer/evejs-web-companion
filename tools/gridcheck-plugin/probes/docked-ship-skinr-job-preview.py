import datetime

from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.client.ships.skins.live_data.sequencing_job import SequencingJob, SequencingJobState
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.studio import studioSignals
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow

job = SequencingJob(None, 'preview-fixture', session.charid, 2)
now = datetime.datetime.now()
job.admin_set_state(SequencingJobState.STARTED)
job.admin_set_started_time(now)
job.admin_set_planned_completion_time(now + datetime.timedelta(hours=1))
fixture = SkinDesign()
fixture.ship_type_id = 32880
fixture.fit_slot(1, 53)
requested = []


class FixtureSkinData(object):

    def get_skin_data(self, skin_hex):
        requested.append(skin_hex)
        if skin_hex == job.skin_hex:
            return fixture
        return None


original_service = current_skin_design.get_ship_skin_data_svc
window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.STUDIO)
    current_skin_design.get_ship_skin_data_svc = FixtureSkinData
    studioSignals.on_sequencing_job_selected(job)
    design = current_skin_design.get()
    fitted = design.get_fitted_component_instance(1)
    observation = dict(station=session.stationid, requests=requested, runs=job.nb_runs,
                       hull=design.ship_type_id, coating=fitted.component_id if fitted else None,
                       scene=bool(window.scene_preview_panel.sceneNavigation))
finally:
    current_skin_design.get_ship_skin_data_svc = original_service
    current_skin_design.reset_design()
    window.Close()

result = observation
