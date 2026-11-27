import blue
from cosmetics.client.ships.skins.live_data import current_skin_design
from eve.client.script.ui.cosmetics.ship.const import SkinrPage
from eve.client.script.ui.cosmetics.ship.pages import current_page
from eve.client.script.ui.cosmetics.ship.pages.store import storeSettings
from eve.client.script.ui.cosmetics.ship.pages.store.sections.activeShip import ActiveShipSectionContainer
from eve.client.script.ui.cosmetics.ship.pages.store.sections.emphasizedShip import EmphasizedShipSectionContainer
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from eve.client.script.ui.shared.info.shipInfoConst import TAB_SKINS
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow, TAB_ID_COSMETIC
from eve.client.script.ui.shared.fittingScreen.cosmetics.cosmeticFitting import TAB_ID_SKINS
from localization import GetByLabel


def observe():
    active = current_skin_design.get_default_ship_type_id()
    other = 587 if active != 587 else 32880
    cases = []
    info = sm.GetService('info')
    for type_id in (other, active, 670):
        if any(row['typeID'] == type_id for row in cases):
            continue
        window = info.ShowInfo(type_id, new=1, selectTabType=TAB_SKINS)
        try:
            for attempt in range(80):
                panel = getattr(getattr(window, '_current_panel', None), 'skinPanel', None)
                section = getattr(panel, '_paragonHubSection', None)
                if section and panel.loaded:
                    break
                blue.pyos.synchro.SleepWallclock(100)
            else:
                raise RuntimeError('SKINs panel did not load for %s' % type_id)
            row = dict(typeID=type_id, visible=bool(section.display), source=section.shipTypeID)
            if section.display:
                section._open_store()
                hub = ShipSKINRWindow.GetIfOpen()
                browser = hub.store_page.skin_browser
                for attempt in range(40):
                    children = list(browser.mainCont.children)
                    if children:
                        break
                    blue.pyos.synchro.SleepWallclock(100)
                emphasis = next((child for child in children if isinstance(child, EmphasizedShipSectionContainer)), None)
                active_section = next((child for child in children if isinstance(child, ActiveShipSectionContainer)), None)
                row.update(page=current_page.get_page_id(), storeVisible=bool(hub.store_page.display),
                           browserVisible=bool(browser.display),
                           emphasized=storeSettings.emphasized_ship_type_id.get(),
                           sections=[type(child).__name__ for child in children],
                           filter=emphasis.section_controller.get_type_filter() if emphasis else [],
                           activeFilter=active_section.section_controller.get_type_filter() if active_section else [])
                current_page.set_page_id(SkinrPage.STUDIO)
                section._open_store()
                row['reused'] = ShipSKINRWindow.GetIfOpen() is hub
                hub.Close()
                row['cleared'] = storeSettings.emphasized_ship_type_id.get()
            cases.append(row)
        finally:
            window.Close()
    fitting = FittingWindow.Open()
    try:
        fitting.fittingModeTabGroup.SelectByID(TAB_ID_COSMETIC)
        blue.pyos.synchro.SleepWallclock(500)
        fitting.cosmeticsPanel.GoToTab(TAB_ID_SKINS)
        fitting.cosmeticsPanel.PopulateSkinPanel()
        section = fitting.cosmeticsPanel.skinPanel._paragonHubSection
        fit = dict(typeID=section.shipTypeID, visible=bool(section.display))
    finally:
        fitting.Close()
    prefix = 'UI/Personalization/ShipSkins/SKINR/Store/'
    return dict(build=3698585, station=session.stationid, active=active, cases=cases,
                fitting=fit, button=GetByLabel(prefix + 'ViewStoreButton'))


result = observe()
