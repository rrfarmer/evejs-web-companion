import uuid

from cosmetics.client.ships.ship_skin_signals import on_skin_sequencing_job_failed
from eve.client.script.ui.cosmetics.ship import shipSKINRWindow
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page

messages = []
original_message = shipSKINRWindow.message_player
window = shipSKINRWindow.ShipSKINRWindow.Open()
job = uuid.uuid4()
observations = []
try:
    shipSKINRWindow.message_player = messages.append
    current_page.set_page_id(SkinrPage.STORE)
    for reason in (0, 1, 2, 3, 4):
        before = len(messages)
        on_skin_sequencing_job_failed(job, reason)
        observations.append(dict(reason=reason, text=messages[-1] if len(messages) > before else None))
finally:
    shipSKINRWindow.message_player = original_message
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = dict(station=session.stationid, observations=observations, shop=True)
