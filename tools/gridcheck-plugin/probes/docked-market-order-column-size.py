import blue
from carbonui.control.scroll import MINCOLUMNWIDTH
from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd
from eve.client.script.ui.shared.market.personalMarketOrders import PersonalMarketOrders
from localization import GetByLabel
from utillib import KeyVal


def observe():
    window = MarketOrdersWnd.GetIfOpen()
    opened = window is None
    read = PersonalMarketOrders.__dict__['GetOrders']

    def rows(self):
        return [KeyVal(orderID=100 + bid, typeID=34, bid=bid, price=10.0, volRemaining=2,
                       volEntered=3, minVolume=1, range=-1, escrow=20.0,
                       stationID=session.stationid, solarSystemID=session.solarsystemid2,
                       regionID=session.regionid, issueDate=blue.os.GetWallclockTime(), duration=1)
                for bid in (0, 1)]

    PersonalMarketOrders.GetOrders = rows
    try:
        if opened:
            window = MarketOrdersWnd.Open(tabID=1)
        panel = window.personalOrders
        if not panel.isInitialized:
            panel.OnTabSelect()
        result = []
        for scroll in (panel.sellScroll, panel.buyScroll):
            header = next(header for header in scroll.GetHeadersChildren()
                          if header.name == GetByLabel('UI/Market/MarketQuote/headerPrice'))
            reset = []
            scroll.ResetColumnWidth = lambda column: reset.append(column)
            try:
                header.OnDblClick()
                header._scaler.OnDblClick()
            finally:
                del scroll.ResetColumnWidth
            result.append(dict(scroll=scroll.sr.id, header=header.__class__.__name__,
                               size=header.SCALE_HANDLE_SIZE, hasHandle=header._scaler is not None,
                               headerDrag=bool(getattr(header, 'isDragObject', False)),
                               reset=reset))
        return dict(station=session.stationid, minimum=MINCOLUMNWIDTH, lists=result)
    finally:
        PersonalMarketOrders.GetOrders = read
        if opened and window is not None:
            window.Close()


result = observe()
