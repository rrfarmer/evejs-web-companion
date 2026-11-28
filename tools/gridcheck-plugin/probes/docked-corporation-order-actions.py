import uthread2
from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd, TABID_CORP
from eve.client.script.ui.shared.market.orders import OrderEntry
from eve.common.lib import appConst
from utillib import KeyVal


def observe(issuer, type_id, price, legacy_order_id):
    if not session.stationid or not session.corprole & appConst.corpRoleAccountant:
        raise RuntimeError('A docked Accountant is required')
    previous = MarketOrdersWnd.GetIfOpen()
    window = MarketOrdersWnd.Open(tabID=TABID_CORP)
    try:
        if not window.corpOrders:
            raise RuntimeError('Corporation Orders did not open for the Accountant')
        panel = window.corpOrders
        panel.OnTabSelect()
        for _ in range(40):
            nodes = panel.buyScroll.GetNodes() if panel.buyScroll else []
            node = next((row for row in nodes if getattr(row, 'order', None) and
                         (row.order.charID == issuer or (row.order.charID == 0 and
                          row.order.orderID == legacy_order_id)) and row.order.typeID == type_id and
                         row.order.price == price), None)
            if node is not None:
                break
            uthread2.sleep(0.25)
        else:
            raise RuntimeError('The live corporation buy order was not in the native list')
        order = node.order
        wire_issuer = order.charID
        row_panel = getattr(node, 'panel', None)
        # Older EveJS returns charID 0 on corporate orders. Only the explicitly
        # identified live row is eligible for the fixture's recorded issuer.
        try:
            if wire_issuer == 0:
                order.charID = issuer
            if row_panel:
                menu = row_panel.GetMenu()
            else:
                entry = KeyVal(sr=KeyVal(node=node), OnClick=lambda: None,
                               CancelOffer=OrderEntry.CancelOffer, ModifyPrice=OrderEntry.ModifyPrice,
                               _GetGMMenu=lambda: [])
                menu = OrderEntry.GetMenu.im_func(entry)
        finally:
            if wire_issuer == 0:
                order.charID = wire_issuer
        actions = [getattr(row[1], '__name__', '') for row in menu if isinstance(row, (list, tuple)) and len(row) > 1 and callable(row[1])]
        return dict(station=session.stationid, actor=session.charid, corporation=session.corpid,
                    accountant=True, order=order.orderID, issuer=issuer, wireIssuer=wire_issuer, price=order.price,
                    actions=actions, projectedPanel=row_panel is None,
                    modify='ModifyPrice' in actions, cancel='CancelOffer' in actions)
    finally:
        if not previous:
            window.Close()


result = observe(issuer, globals().get('type_id', 34), globals().get('price', 0.11), globals().get('legacy_order_id'))
