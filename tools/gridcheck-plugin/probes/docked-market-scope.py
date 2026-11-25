# Read the native market's docked scope options and saved availability flag.
from eve.client.script.ui.shared.market.marketbase import MarketBase
from eve.common.script.sys import idCheckers
from localization import GetByLabel

quote = sm.GetService('marketutils')
result = {
    'station': session.stationid,
    'options': list(MarketBase.GetOptions.im_func(None)),
    'current': quote.GetMarketRange(),
    'availabilityLabel': GetByLabel('UI/Market/ShowOnlyAvailable'),
    'availability': bool(settings.user.ui.Get('showonlyavailable', True)),
    'wormholeBounds': [idCheckers.IsWormholeRegion(value) for value in (10999999, 11000000, 11999999, 12000000)],
}
