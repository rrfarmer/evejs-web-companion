import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from eveexceptions import UserError


def observe():
    catalog = sm.GetService('helpPointer').GetHighlightByElementName()
    names = ('marketBrowseSettings', 'orderDuration', 'findTypeInBrowser', 'buyersList', 'sellersList',
             'marketSellersJumpsColumn', 'marketSellersQtyColumn', 'marketSellersPriceColumn',
             'marketBuyersJumpsColumn', 'marketBuyersQtyColumn', 'marketBuyersPriceColumn',
             'marketDetailsTab', 'marketPriceHistoryTab', 'marketDataTab')
    ids = ['unique_UI_' + name for name in names]
    rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
                 chain=FindChainForPointer(name)) for name in ids]

    def visible():
        anchors = GetScreenElementsByUniqueName(ids)
        return dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                    if element and not element.destroyed and element.IsVisible())

    opened = RegionalMarket.GetIfOpen()
    if not opened:
        uicore.cmd.OpenMarket()
    window = RegionalMarket.GetIfOpen()
    try:
        blue.pyos.synchro.SleepWallclock(300)
        initial = visible()
        selected = {}
        market_error = None
        if window and not opened:
            try:
                window.LoadTypeID_Ext(34)
            except UserError as error:
                market_error = str(error)
            blue.pyos.synchro.SleepWallclock(1800)
            selected = visible()
        return dict(station=session.stationid, typeID=34, rows=rows, initial=initial,
                    selected=selected, marketError=market_error)
    finally:
        if window and not opened:
            window.Close()


result = observe()
