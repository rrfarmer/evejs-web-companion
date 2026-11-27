"""Read the active native trade window and the offer manifest it displays."""
import blue
from carbonui.control.window import Window
from localization import GetByLabel

window = None
for _ in xrange(60):
    window = Window.GetIfOpen(windowID='tradeWnd')
    if window is not None and getattr(window, 'tradeSession', None) is not None:
        break
    blue.synchro.SleepWallclock(100)
if window is None or window.tradeSession is None:
    raise RuntimeError('No active trade window')
trade = window.tradeSession.List()
result = {
    'station': session.stationid,
    'pilot': session.charid,
    'container': trade.tradeContainerID,
    'traders': list(trade.traders),
    'money': list(trade.money),
    'displayedMoney': [window.sr.myMoney.amount, window.sr.herMoney.amount],
    'accepted': [bool(offer) for offer in trade.state],
    'items': sorted([item.itemID for item in trade.items]),
    'controls': [GetByLabel(label) for label in ('UI/PVPTrade/OfferMoney', 'UI/PVPTrade/Accept', 'UI/Common/Buttons/Cancel')],
}
