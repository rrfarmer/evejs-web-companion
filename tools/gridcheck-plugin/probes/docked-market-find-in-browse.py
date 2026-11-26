import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eveexceptions import UserError
from localization import GetByLabel


def observe():
    type_id = 34
    original = settings.user.ui.Get('showonlyavailable', True)
    opened = RegionalMarket.GetIfOpen()
    if not opened:
        uicore.cmd.OpenMarket()
    window = RegionalMarket.GetIfOpen()
    market = window.sr.market
    browse = GetByLabel('UI/Market/Browse')
    selection_error = None
    try:
        market.sr.tabs.ShowPanelByName(GetByLabel('UI/Common/Details'))
        blue.pyos.synchro.SleepWallclock(350)
        market.LoadDetails()
        button = market.browseBtn
        search = market.sr.searchInput
        trace = market.sr.detailGroupTrace
        hidden = not button.display
        group, path = sm.GetService('marketutils').FindMarketGroup(type_id)
        trace.typeID = type_id
        trace.sr.marketGroupInfo = group
        settings.user.ui.Set('showonlyavailable', True)
        search.SetText('Tritanium')
        market.sr.sbTabs.ShowPanelByName(GetByLabel('UI/Market/QuickBar'))
        blue.pyos.synchro.SleepWallclock(120)
        try:
            market.OpenOnType(trace)
        except UserError as error:
            selection_error = str(error)
        blue.pyos.synchro.SleepWallclock(380)
        return dict(station=session.stationid, typeID=type_id, emptyButtonHidden=hidden,
                    hint=button.hint, path=path, browse=browse, tab=market.sr.sbTabs.GetSelectedArgs(),
                    search=search.GetValue(), onlyAvailable=settings.user.ui.Get('showonlyavailable', True),
                    selected=[node.get('typeID') for node in market.sr.typescroll.GetSelected()],
                    chain=FindChainForPointer('unique_UI_findTypeInBrowser'), error=selection_error)
    finally:
        settings.user.ui.Set('showonlyavailable', original)
        if not opened:
            window.Close()


result = observe()
