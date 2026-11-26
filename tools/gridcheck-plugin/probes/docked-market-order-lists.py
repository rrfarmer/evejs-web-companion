from eve.client.script.ui.shared.market.corpMarketOrders import CorpMarketOrders
from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd
from eve.client.script.ui.shared.market.orders import MarketOrders
from eve.client.script.ui.shared.market.personalMarketOrders import PersonalMarketOrders
from localization import GetByLabel
from utillib import KeyVal


def observe():
    window = MarketOrdersWnd.GetIfOpen()
    opened = window is None
    read = PersonalMarketOrders.__dict__['GetOrders']
    # The native reference can expose the controls with an empty local list even
    # when its market daemon is unavailable. Restore the method before leaving.
    PersonalMarketOrders.GetOrders = lambda self: []
    try:
        if opened:
            window = MarketOrdersWnd.Open(tabID=1)
        personal = window.personalOrders
        if not personal.isInitialized:
            personal.OnTabSelect()
        market = sm.GetService('marketutils')
        order = KeyVal(volRemaining=2, volEntered=7, minVolume=4, range=-1, typeID=34)
        quantity, minimum, order_range = [KeyVal(label='') for _ in range(3)]
        market.GetQuantitySlashVolume(order, quantity)
        market.GetMinVolume(order, minimum)
        market.GetRange(order, order_range)
        return dict(
            station=session.stationid,
            selling=personal.GetSellHeaders(),
            buying=personal.GetBuyHeaders(),
            corporation=[GetByLabel(label) for label in (
                'UI/Market/MarketQuote/headerIssuedBy', 'UI/Market/MarketQuote/headerWalletDivision')],
            corporationUsesSharedLists=issubclass(CorpMarketOrders, MarketOrders),
            distinctFilters=personal.sellFilter is not personal.buyFilter,
            smartSort=[personal.sellScroll.smartSort, personal.buyScroll.smartSort],
            labels=[GetByLabel(label) for label in (
                'UI/Market/Orders/Selling', 'UI/Market/Orders/Buying', 'UI/Market/Orders/FilterTypes',
                'UI/Market/Orders/NoOrdersFound', 'UI/Market/Marketbase/NoOrdersMatched')],
            values=[quantity.label, minimum.label, order_range.label])
    finally:
        PersonalMarketOrders.GetOrders = read
        if opened and window is not None:
            window.Close()


result = observe()
