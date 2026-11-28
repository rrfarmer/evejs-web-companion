from eve.client.script.ui.shared.market.marketbase import MarketBase
from eve.common.script.sys import idCheckers
from localization import GetByLabel
from utillib import KeyVal


def observe():
    quote = sm.StartService('marketQuote')
    methods = ('GetStationAsks', 'GetSystemAsks', 'GetRegionBest')
    saved = dict((name, (name in quote.__dict__, getattr(quote, name))) for name in methods)
    calls = []

    def record(name, invoke):
        def wrapped(*args, **kwargs):
            calls.append(name)
            return invoke(*args, **kwargs)
        return wrapped

    try:
        for name in methods:
            setattr(quote, name, record(name, saved[name][1]))
        rows = MarketBase._GetAsksForRange.im_func(KeyVal(GetRange=lambda: const.rangeRegion))
        return dict(system=session.solarsystemid2, region=session.regionid, station=session.stationid,
                    wormhole=idCheckers.IsWormholeRegion(session.regionid), range=const.rangeRegion,
                    label=GetByLabel('UI/Common/LocationTypes/Region'), calls=calls, rows=len(rows))
    finally:
        for name, (existed, original) in saved.items():
            if existed:
                setattr(quote, name, original)
            else:
                delattr(quote, name)


result = observe()
