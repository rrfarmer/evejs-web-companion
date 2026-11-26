from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd
from eve.client.script.ui.shared.market.personalMarketOrders import PersonalMarketOrders
from localization import GetByLabel


def observe():
    window = MarketOrdersWnd.GetIfOpen()
    opened = window is None
    read = PersonalMarketOrders.__dict__['GetOrders']
    PersonalMarketOrders.GetOrders = lambda self: []
    try:
        if opened:
            window = MarketOrdersWnd.Open(tabID=1)
        panel = window.personalOrders
        if not panel.isInitialized:
            panel.OnTabSelect()
        divider = panel.dividerCont
        original = divider._GetSize()
        try:
            divider._SetSize(0.1)
            lower = divider._GetSize()
            divider._SetSize(0.9)
            upper = divider._GetSize()
        finally:
            divider._SetSize(original)
        scroll = panel.buyScroll
        column = GetByLabel('UI/Common/Range')
        # Empty lists clear Scroll's headers. Supply the panel's header set
        # for the menu measurement and restore the empty list immediately.
        headers = scroll.sr.headers
        try:
            scroll.sr.headers = panel.GetBuyHeaders()
            visible = scroll.GetColumns()
            options = [GetByLabel(entry[0][0], **entry[0][1]) for entry in scroll.GetHeaderMenu(column) if entry]
            scroll.GetColumns = lambda: [label for label in visible if label != column]
            try:
                restore = [GetByLabel(entry[0][0], **entry[0][1]) for entry in scroll.GetShowColumnMenu() if entry]
            finally:
                del scroll.GetColumns
        finally:
            scroll.sr.headers = headers
        return dict(station=session.stationid, divider=[original, lower, upper],
                    dividerKey=divider.settingsID, sharedIDs=[panel.sellScroll.sr.id, scroll.sr.id],
                    headerMenu=options, restoreMenu=restore, buying=visible)
    finally:
        PersonalMarketOrders.GetOrders = read
        if opened and window is not None:
            window.Close()


result = observe()
