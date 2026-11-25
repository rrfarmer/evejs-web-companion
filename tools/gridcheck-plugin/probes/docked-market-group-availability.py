import evetypes
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from localization import GetByLabel
from utillib import KeyVal


def observe():
    if RegionalMarket.GetIfOpen():
        return {'alreadyOpen': True}
    saved = settings.user.ui.Get('showonlyavailable', 1)
    try:
        sm.GetService('cmd').OpenMarket()
        market = RegionalMarket.GetIfOpen().sr.market
        market.asksForMyRange = {
            type_id: KeyVal(price=2207.03, volRemaining=5000, stationID=session.stationid)
            for type_id in evetypes.GetTypeIDsByMarketGroup(518) if type_id != 17470}
        results = []
        for enabled in (0, 1):
            settings.user.ui.Set('showonlyavailable', enabled)
            groups = []
            for group_id in (518, 396):
                group = KeyVal(marketGroupID=group_id)
                rows = market.FilterItemsForGroupPage(group)
                groups.append({'group': group_id, 'count': len(rows),
                               'unquoted': [[row.typeID, row.fmt_price] for row in rows if not row.qty]})
            results.append(groups)
        return {'station': session.stationid, 'results': results,
                'empty': GetByLabel('UI/Market/Marketbase/NoItemsAvailable'),
                'hint': GetByLabel('UI/Market/Marketbase/DisableShowOnlyAvailable')}
    finally:
        settings.user.ui.Set('showonlyavailable', saved)
        window = RegionalMarket.GetIfOpen()
        if window:
            window.Close()


result = observe()
