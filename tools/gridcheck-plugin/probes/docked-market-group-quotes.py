import const
from eve.client.script.ui.shared.market.util import get_best_price_in_place_text, get_units_available_text
from localization import GetByLabel


def observe():
    market = sm.GetService('marketQuote')
    samples = {}
    for station_id in [session.stationid, 60003751, 60003757, 60003760, 60000358, 60008494]:
        if not station_id:
            continue
        try:
            system_id = market.GetSolarSystemForMarketLocation(station_id)
        except KeyError:
            continue
        jumps = market.GetStationDistance(station_id, False)
        if jumps == -1:
            distance = GetByLabel('UI/Market/Marketbase/InThisStation')
        elif jumps == 0:
            distance = GetByLabel('UI/Market/Marketbase/InThisSystem')
        else:
            distance = GetByLabel('UI/Market/Marketbase/JumpsAway', jumps=jumps)
        samples[str(station_id)] = {
            'system': system_id, 'jumps': jumps,
            'text': get_units_available_text(1230, 25000, distance)}
    return {
        'station': session.stationid,
        'system': session.solarsystemid2,
        'rangeRegion': const.rangeRegion,
        'scopes': [get_best_price_in_place_text(1230, GetByLabel('UI/Common/LocationTypes/' + scope))
                   for scope in ['Station', 'System', 'Region']],
        'samples': samples}


result = observe()
