from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal

def observe():
    module = __import__(MarketOrdersWnd.__module__, fromlist=['MarketOrdersWnd'])
    namespace = module.__dict__
    existed = 'session' in namespace
    saved = namespace.get('session')
    cases = []
    try:
        for role in [0, appConst.corpRoleAccountant, appConst.corpRoleJuniorAccountant, appConst.corpRoleTrader]:
            namespace['session'] = KeyVal(corprole=role)
            cases.append(bool(MarketOrdersWnd.IsCorpOrdersAccessible.im_func(None)))
    finally:
        if existed:
            namespace['session'] = saved
        else:
            namespace.pop('session', None)
    return dict(station=session.stationid, cases=cases, labels=[GetByLabel(label) for label in [
        'UI/Market/Orders/MyOrders', 'UI/Market/Orders/CorporationOrders', 'UI/Market/Orders/MyOrderHistory',
        'UI/Market/MarketQuote/headerIssuedBy', 'UI/Market/MarketQuote/headerWalletDivision',
        'UI/Market/Orders/CancelOrder', 'UI/Market/Orders/ModifyOrder']])

result = observe()
