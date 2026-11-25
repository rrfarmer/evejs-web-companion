from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from utillib import KeyVal


def observe():
    if RegionalMarket.GetIfOpen():
        return {'alreadyOpen': True}
    try:
        sm.GetService('cmd').OpenMarket()
        market = RegionalMarket.GetIfOpen().sr.market
        requests = []
        previous = market.OpenMultiBuy
        market.OpenMultiBuy = lambda wanted: requests.append(sorted(wanted.items()))
        try:
            market.OnOpenMultiBuyBtn()
            market.OnDropOnMultibuyBtn(None, [
                KeyVal(typeID=483, extraText='2'),
                KeyVal(typeID=32880),
                KeyVal(typeID=483, extraText='4'),
                KeyVal(typeID=34, extraText='not a quantity')])
        finally:
            market.OpenMultiBuy = previous
        return {'station': session.stationid, 'requests': requests}
    finally:
        window = RegionalMarket.GetIfOpen()
        if window:
            window.Close()


result = observe()
