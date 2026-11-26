import trinity
from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from cosmetics.common.ships.skins.static_data.component_category import ComponentCategory
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.studio.skinrBackgroundContainer import DEFAULT_PATTERN_SHOWCASE_MATERIAL_ID
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow

window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.STORE)
    preview = window.scene_preview_panel
    observations = []
    for category, component_id in ((ComponentCategory.MATERIAL, 1349), (ComponentCategory.METALLIC, 53),
                                   (ComponentCategory.PATTERN, 179)):
        preview.apply_component(category, component_id)
        design = current_skin_design.get()
        slots = {}
        for slot in range(1, 9):
            fitted = design.get_fitted_component_instance(slot)
            if fitted is not None:
                slots[slot] = fitted.component_id
        observations.append(dict(component=component_id, hull=design.ship_type_id, slots=slots))
    showcase = ComponentsDataLoader.GetData()[DEFAULT_PATTERN_SHOWCASE_MATERIAL_ID]
    data = dict(station=session.stationid, samples=observations, showcase=DEFAULT_PATTERN_SHOWCASE_MATERIAL_ID,
                material=trinity.Load(showcase.resource_file).name)
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
