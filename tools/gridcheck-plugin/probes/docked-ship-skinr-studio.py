from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from eve.client.script.ui.shared.neocom.neocom import neocomConst
from eve.client.script.ui.shared.neocom.neocom.btnData import btnDataRaw
from localization import GetByLabel

skinr_button = next(row for row in neocomConst.RAWDATA_EVEMENU_GROUP_PARAGON_SERVICES[2]
                    if btnDataRaw.BTNDATARAW_BY_ID[row[1]].cmdName == 'OpenShipSKINRWindow')
window = ShipSKINRWindow.Open()
try:
    home = window.studio_page.home_page
    result = dict(station=session.stationid, caption=GetByLabel(window.default_captionLabelPath),
                  icon=window.default_iconNum, studio=current_page.get_page_id() == SkinrPage.STUDIO,
                  studioLabel=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/Title'),
                  saved=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/SavedDesigns'),
                  sequencing=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/SequencingInProgress'),
                  savedCount=home.saved_designs_section.num_items_label.text,
                  sequencingCount=home.sequencing_in_progress_section.num_items_label.text,
                  paragonIndex=neocomConst.RAWDATA_EVEMENU_GROUP_PARAGON_SERVICES[2].index(skinr_button))
finally:
    window.Close()
