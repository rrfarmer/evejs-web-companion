from cosmetics.client.ships.skins.live_data import section_controller
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/'
window = ShipSKINRWindow.Open()
try:
    current_page.set_page_id(SkinrPage.COLLECTION)
    page = window.collection_page
    page.show_skins()
    skins_page = page.skin_browser.display and not page.component_browser.display
    page.show_components()
    elements_page = page.component_browser.display and not page.skin_browser.display
    sections = [section_controller.CollectionAllActivatedSkinsSection, section_controller.CollectionAllUnactivatedSkinsSection,
                section_controller.CollectionNanocoatingComponentsSection, section_controller.CollectionMetallicComponentsSection,
                section_controller.CollectionPatternComponentsSection]
    data = dict(station=session.stationid, skinsPage=skins_page, elementsPage=elements_page,
                title=GetByLabel(prefix + 'Collection/Title'), tabs=[GetByLabel(prefix + 'Studio/' + label) for label in ('SKINs', 'DesignElements')],
                sections=[GetByLabel(section.name) for section in sections], activate=GetByLabel(prefix + 'Collection/Activate'))
finally:
    current_page.set_page_id(SkinrPage.STUDIO)
    window.Close()

result = data
