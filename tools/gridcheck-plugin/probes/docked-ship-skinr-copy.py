from cosmetics.client.ships.skins.live_data import current_skin_design
from eve.client.script.ui.cosmetics.ship.pages.studio.saveSkinButton import SaveAsSkinButton
from eve.client.script.ui.cosmetics.ship.pages.studio.skinNameDialogue import SkinNameDialogue
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
current_skin_design.create_blank_design()
caption = SaveAsSkinButton.get_dialogue_window_name.im_func(None)
window = SkinNameDialogue(window_name=caption)
try:
    capacity = type('SaveCapacity', (object,), {'design_count': 4, 'design_limit': 5})()
    restricted = SaveAsSkinButton.is_restricted_by_design_limit.im_func
    available = not restricted(capacity)
    capacity.design_count = 5
    observation = dict(station=session.stationid, action=GetByLabel(prefix + 'SaveAs'), caption=caption,
                       save=window.get_action_button_name(), available=available, full=restricted(capacity),
                       limit=GetByLabel(prefix + 'DesignErrors/SaveLimitReached', current=5, limit=5))
finally:
    window.Close()
result = observation
