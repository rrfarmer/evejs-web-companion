from cosmetics.client.ships.skins.static_data.store_section import StoreSection
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.store import storeSettings
from eve.client.script.ui.cosmetics.ship.pages.store.sections.myListings import ViewAllSkinsListedByMeSectionContainer
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Store/'
paths = ('Title', 'MyListings', 'ListedTo', 'ListedToSpecific', 'ListedByAnyone',
         'TimeLeft', 'TimeLeftReversed', 'RemoveListing', 'MaxListingsTooltip')
message = cfg.GetMessage('ConfirmRemoveSkinListing', {}, onNotFound='raise')
window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.STORE_SKINS, StoreSection.SKINS_MY_LISTINGS)
    page = window.store_page
    sections = [child for child in page.skin_browser.children
                if isinstance(child, ViewAllSkinsListedByMeSectionContainer)]
    data = dict(station=session.stationid, pageVisible=bool(page.display),
                ownedSections=len(sections), labels={key: GetByLabel(prefix + key) for key in paths},
                defaultTarget=str(storeSettings.listed_to_setting.get()),
                sortOptions=[(str(key), ascending) for key, ascending in storeSettings.skins_sort_by_options],
                prompt=dict(title=message.title, text=message.text))
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
