import blue
from carbonui.primitives.container import Container
from cosmetics.client.ships.skins.live_data import current_skin_design
from eve.client.script.ui.cosmetics.ship.pages.store import storeSettings
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from eve.client.script.ui.shared.info.shipInfoConst import TAB_SKINS
from eve.client.script.ui.shared.info.shipInfoWindow import ShipInfoWindow
from eve.client.script.ui.shared.preview import PreviewWnd
from eve.client.script.ui.view.aurumstore.aurumStoreContainer import AurumStoreContainer, PAGE_HOME, ROOT_CATEGORY_SHIP_SKINS
from eve.client.script.ui.view.aurumstore.vgsOfferGrid import OfferGrid
from eve.client.script.ui.view.viewStateConst import ViewState
from localization import GetByLabel
from utillib import KeyVal


def get_preview():
    sm.GetService('preview').PreviewType(587)
    for attempt in range(65):
        windows = sm.GetService('info')._GetOpenWindowsForType(587)
        window = next((item for item in windows if isinstance(item, ShipInfoWindow)), None)
        panel = getattr(getattr(window, '_current_panel', None), 'skinPanel', None)
        if panel and panel.loaded:
            try:
                return dict(typeID=window.typeID, skins=window.GetSelectedTabIdx() == TAB_SKINS,
                            launcher=bool(panel._paragonHubSection.display),
                            previewWindow=PreviewWnd.GetIfOpen() is not None)
            finally:
                window.Close()
        blue.pyos.synchro.SleepWallclock(100)
    raise RuntimeError('Preview service did not open the hull SKINs panel')


def observe():
    preview = get_preview()
    view_state = sm.GetService('viewState')
    store = sm.GetService('vgsService')
    store.ToggleStore()
    view = view_state.GetView(ViewState.VirtualGoodsStore)
    for attempt in range(65):
        container = getattr(view, 'storeContainer', None)
        banner = getattr(getattr(container, 'grid', None), 'ship_skin_banner', None)
        if banner and not banner.destroyed:
            break
        blue.pyos.synchro.SleepWallclock(100)
    home = bool(banner and not banner.destroyed)
    scratch = None
    try:
        if not home:
            scratch = Container(parent=view.layer)
            grid = OfferGrid(parent=scratch)
            grid.SetOffers([], show_skinr_banner=True)
            banner = grid.ship_skin_banner
        def gate(page, category):
            return AurumStoreContainer.should_show_skinr_banner.fget(KeyVal(page=page, selectedRootCategoryId=category))
        before = view_state.IsViewActive(ViewState.VirtualGoodsStore)
        banner.OnClick()
        hub = ShipSKINRWindow.GetIfOpen()
        for attempt in range(50):
            if hub and not view_state.IsViewActive(ViewState.VirtualGoodsStore) and hub.store_page.skin_browser.display:
                break
            blue.pyos.synchro.SleepWallclock(100)
            hub = ShipSKINRWindow.GetIfOpen()
        return dict(build=3698585, station=session.stationid, preview=preview, actualHomeBanner=home,
                    gate=[gate(PAGE_HOME, None), gate(-1, ROOT_CATEGORY_SHIP_SKINS), gate(-1, None)],
                    activeBefore=before, activeAfter=view_state.IsViewActive(ViewState.VirtualGoodsStore),
                    hub=bool(hub and hub.store_page.display and hub.store_page.skin_browser.display),
                    emphasized=storeSettings.emphasized_ship_type_id.get(),
                    activeHull=current_skin_design.get_default_ship_type_id(),
                    ribbon=GetByLabel('UI/VirtualGoodsStore/SKINR/Ribbon'),
                    description=GetByLabel('UI/VirtualGoodsStore/SKINR/Description'))
    finally:
        hub = ShipSKINRWindow.GetIfOpen()
        if hub:
            hub.Close()
        if scratch and not scratch.destroyed:
            scratch.Close()
        if view_state.IsViewActive(ViewState.VirtualGoodsStore):
            store.ToggleStore()


result = observe()
