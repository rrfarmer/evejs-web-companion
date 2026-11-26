from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
window = ShipSKINRWindow.Open()
try:
    window.studio_page.home_page._on_create_new_design_btn()
    initial = SkinDesign(session.charid)
    initial.ship_type_id = 32880
    initial.name = 'Perimeter Dawn'
    initial.line_name = 'Yard Trials'
    initial.fit_slot(1, 53)
    current_skin_design.update_from_other(initial, saved_skin_design_id='gridcheck-local-fixture', animate=False)
    design = current_skin_design.get()
    clean = not current_skin_design.has_changes_from_snapshot()
    restored_coating = design.get_fitted_component_instance(1).component_id
    design.fit_slot(1, 105)
    prompt = cfg.GetMessage('SKINRUnsavedDesign', {}, onNotFound='raise')
    observation = dict(station=session.stationid, inDesigner=current_page.get_page_id() == SkinrPage.STUDIO_DESIGNER,
                       edit=GetByLabel(prefix + 'EditDesign'), name=design.name, line=design.line_name,
                       movedID=design.saved_skin_design_id, initial=restored_coating,
                       replacement=design.get_fitted_component_instance(1).component_id,
                       clean=clean, dirty=current_skin_design.has_changes_from_snapshot(),
                       discard=prompt.text, confirmKind=prompt.type)
finally:
    current_skin_design.take_snapshot()
    window.Close()
result = observation
