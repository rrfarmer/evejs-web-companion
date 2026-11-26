import trinity
from cosmetics.client.ships.skins.live_data import current_skin_design
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from eve.client.script.environment.spaceObject.cosmeticsConst import AREA_MAPS
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow

class ListingFixture(object):
    pass

window = ShipSKINRWindow.Open()
try:
    component = ComponentsDataLoader.GetData()[53]
    design = SkinDesign(session.charid)
    design.ship_type_id = 32880
    design.fit_slot(1, 53)
    listing = ListingFixture()
    listing.skin_design = design
    preview = window.scene_preview_panel
    views = []
    for name, page in (('Studio', SkinrPage.STUDIO), ('Collection', SkinrPage.COLLECTION), ('Paragon Hub', SkinrPage.STORE)):
        current_page.set_page_id(page)
        views.append(dict(name=name, sameScene=window.scene_preview_panel is preview,
                          hasNavigation=bool(preview and preview.sceneNavigation)))
    preview.on_store_skin_listing_selected(listing)
    selected = current_skin_design.get()
    data = dict(station=session.stationid, views=views, ship=selected.ship_type_id,
                fitted=selected.has_fitted_components(), material=trinity.Load(component.resource_file).name,
                primaryArea=AREA_MAPS[500014].get(1))
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
