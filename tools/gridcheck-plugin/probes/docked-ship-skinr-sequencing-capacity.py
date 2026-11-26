from cosmetics.common.ships.skins.sequencing_util import get_maximum_concurrent_sequencing_jobs
from cosmetics.common.ships.skins.static_data import sequencing_const
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel
import evetypes

skills = sequencing_const.max_concurrent_jobs_skills
window = ShipSKINRWindow.Open()
try:
    section = window.studio_page.home_page.sequencing_in_progress_section
    section.update_num_items_label()
    result_data = dict(station=session.stationid, count=section.num_items_label.text,
                       help=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/MaxConcurrentSequencingJobsTooltipText'),
                       skills=[dict(typeID=skill, name=evetypes.GetName(skill),
                                    limits=[get_maximum_concurrent_sequencing_jobs(
                                        lambda skill_id: level if skill_id == skill else 0) for level in range(6)])
                               for skill in skills],
                       maximum=get_maximum_concurrent_sequencing_jobs(lambda skill_id: 5))
finally:
    window.Close()

result = result_data
