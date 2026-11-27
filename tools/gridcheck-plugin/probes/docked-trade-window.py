"""Read the active native trade window and the offer manifest it displays."""
import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.control.window import Window
from eveservices.menu import GetMenuService
from inventorycommon import const
from localization import GetByLabel
from menucheckers.itemCheckers import ItemChecker


def label_of(entry):
    if isinstance(entry, (list, tuple)) and entry:
        entry = entry[0]
    if hasattr(entry, 'GetLabelPath'):
        return entry.GetLabelPath()
    return getattr(entry, 'labelPath', entry if isinstance(entry, basestring) else None)


def menu_of(items):
    entries = GetMenuService().InvItemMenu([(item, True, None) for item in items])
    parsed = CreateMenuDataFromRawTuples(entries)
    return [label_of(entry) for entry in parsed] if parsed else []


window = None
for _ in xrange(60):
    window = Window.GetIfOpen(windowID='tradeWnd')
    if window is not None and getattr(window, 'tradeSession', None) is not None:
        break
    blue.synchro.SleepWallclock(100)
if window is None or window.tradeSession is None:
    raise RuntimeError('No active trade window')
trade = window.tradeSession.List()
trade_item = window.tradeSession.GetSelfInvItem()
inventory_item = sm.GetService('invCache').GetInventoryFromId(trade.tradeContainerID).GetItem()
plex = []
item_menus = []
for item in trade.items:
    item_menus.append({'item': item.itemID, 'type': item.typeID, 'owner': item.ownerID,
                       'menu': menu_of([item])})
    if item.typeID == const.typePlex:
        checker = ItemChecker(item)
        entries = GetMenuService().InvItemMenu(item, viewOnly=True)
        plex.append({'item': item.itemID, 'owner': item.ownerID, 'location': item.locationID,
                     'quantity': item.stacksize, 'inTrade': checker.IsInTradeSession(),
                     'offersDeposit': checker.OfferRedeemCurrency(),
                     'menu': [label for label in map(label_of, entries) if label]})
result = {
    'station': session.stationid,
    'pilot': session.charid,
    'container': trade.tradeContainerID,
    'tradeType': trade_item.typeID,
    'inventoryType': inventory_item.typeID,
    'inventoryGroup': inventory_item.groupID,
    'traders': list(trade.traders),
    'money': list(trade.money),
    'displayedMoney': [window.sr.myMoney.amount, window.sr.herMoney.amount],
    'accepted': [bool(offer) for offer in trade.state],
    'items': sorted([item.itemID for item in trade.items]),
    'itemMenus': item_menus,
    'plex': plex,
    'controls': [GetByLabel(label) for label in ('UI/PVPTrade/OfferMoney', 'UI/PVPTrade/Accept', 'UI/Common/Buttons/Cancel')],
}
