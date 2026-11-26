from cosmetics.client.ships.feature_flag import are_skin_hub_offers_enabled
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.store.sections.baseSkinsSectionContainer import MAX_NUM_PER_PAGE
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel

window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.STORE)
    page = window.store_page
    page.show_skins()
    paths = ('Studio/ActiveShipSKINs', 'Studio/AllSKINs', 'Store/CorpSkins', 'Store/AllianceSkins',
             'Store/TargetedAtMe', 'Store/TimeLeft', 'Store/TimeLeftReversed', 'Store/Title')
    prefix = 'UI/Personalization/ShipSkins/SKINR/'
    data = dict(station=session.stationid, pageVisible=bool(page.display),
                offersEnabled=bool(are_skin_hub_offers_enabled()), pageSize=MAX_NUM_PER_PAGE,
                labels={path: GetByLabel(prefix + path) for path in paths},
                sections=[type(child).__name__ for child in page.skin_browser.mainCont.children])
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
