import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.market import marketbase
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from eveexceptions import UserError
from localization import GetByLabel


def observe_empty(market):
    book = market.sr.marketdata.children[0]
    data_label = GetByLabel('UI/Market/MarketData')
    history_label = GetByLabel('UI/Market/Marketbase/PriceHistory')
    original_prompt = marketbase.prompt_player_fsd_dialog
    notices = []

    def record_notice(name, values):
        notices.append([name, values['notify']])

    try:
        marketbase.prompt_player_fsd_dialog = record_notice
        book.PlaceOrder('buy')
    finally:
        marketbase.prompt_player_fsd_dialog = original_prompt
    captions = [GetByLabel('UI/Market/Marketbase/' + name) for name in ('Sellers', 'Buyers')]
    counts = [len(book.sr.buyscroll.GetNodes()), len(book.sr.sellscroll.GetNodes())]
    market.sr.detailtabs.ShowPanelByName(history_label)
    blue.pyos.synchro.SleepWallclock(120)
    history = dict(shown=market.sr.pricehistory.IsVisible(), bookShown=market.sr.marketdata.IsVisible(),
                   children=len(market.sr.pricehistory.children))
    market.sr.detailtabs.ShowPanelByName(data_label)
    return dict(title=market.sr.detailTop.text, captions=captions, counts=counts,
                tabs=[data_label, history_label], history=history, notices=notices)


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
        empty = None
        market_error = None
        if window and not opened:
            market = window.sr.market
            if market.GetSelection() is None and market.sr.marketdata:
                empty = observe_empty(market)
            try:
                window.LoadTypeID_Ext(34)
            except UserError as error:
                market_error = str(error)
            blue.pyos.synchro.SleepWallclock(1800)
            selected = visible()
        return dict(station=session.stationid, typeID=34, rows=rows, initial=initial,
                    selected=selected, marketError=market_error, empty=empty)
    finally:
        if window and not opened:
            window.Close()


result = observe()
