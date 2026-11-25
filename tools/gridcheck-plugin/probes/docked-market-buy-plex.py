from fastcheckout.const import FROM_PLEX_MARKET_GROUP
from localization import GetByLabel


def observe():
    checkout = sm.GetService('fastCheckoutClientService')
    calls = []
    fast = checkout.buy_plex_via_fast_checkout
    online = checkout.buy_plex_online
    try:
        checkout.buy_plex_via_fast_checkout = lambda context: calls.append(['fast', context])
        checkout.buy_plex_online = lambda log_context=None: calls.append(['online', log_context])
        china = checkout.is_china_funnel()
        if not china:
            uicore.cmd.CmdBuyPlex(logContext=FROM_PLEX_MARKET_GROUP)
    finally:
        checkout.buy_plex_via_fast_checkout = fast
        checkout.buy_plex_online = online
    rows = checkout.remote_service.GetOffersForUser().get('plex', [])
    return {'station': session.stationid, 'china': china, 'calls': calls,
            'label': GetByLabel('UI/VirtualGoodsStore/Buttons/BuyPlex'),
            'offers': [[row.id, row.quantity, row.price, row.currency] for row in rows]}


result = observe()
