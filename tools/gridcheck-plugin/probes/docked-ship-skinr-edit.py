from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.common.ships.skins.static_data import skin_const
from eve.client.script.ui.cosmetics.ship.pages.studio.skinNameDialogue import SkinNameDialogue
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
current_skin_design.create_blank_design()
window = SkinNameDialogue(window_name=GetByLabel(prefix + 'SaveDesign'))
try:
    observation = dict(station=session.stationid, edit=GetByLabel(prefix + 'EditDesign'),
                       caption=GetByLabel(prefix + 'SaveDesign'), save=window.get_action_button_name(),
                       name=GetByLabel(prefix + 'SKINName'), line=GetByLabel(prefix + 'SKINLineNameOptional'),
                       nameValue=window.form.get_component(window.COMPONENT_NAME).get_value(),
                       lineValue=window.form.get_component(window.COMPONENT_LINE).get_value(),
                       nameMin=skin_const.name_min_length, nameMax=skin_const.name_max_length,
                       lineMin=skin_const.line_name_min_length, lineMax=skin_const.line_name_max_length)
finally:
    window.Close()
result = observation
