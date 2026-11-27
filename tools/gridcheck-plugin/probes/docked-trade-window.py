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


def parsed_menu(items):
    entries = GetMenuService().InvItemMenu([(item, True, None) for item in items])
    return CreateMenuDataFromRawTuples(entries) or []


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
                       'menu': [label_of(entry) for entry in parsed_menu([item])]})
    if item.typeID == const.typePlex:
        checker = ItemChecker(item)
        entries = GetMenuService().InvItemMenu(item, viewOnly=True)
        plex.append({'item': item.itemID, 'owner': item.ownerID, 'location': item.locationID,
                     'quantity': item.stacksize, 'inTrade': checker.IsInTradeSession(),
                     'offersDeposit': checker.OfferRedeemCurrency(),
                     'menu': [label for label in map(label_of, entries) if label]})

selection_menus = []
panes = []
for owner, pane in zip((session.charid, window.sr.herinfo.ownerID), (window.sr.my, window.sr.her)):
    held = sorted((item for item in trade.items if item.ownerID == owner), key=lambda item: item.typeID)
    panes.append({'owner': owner, 'viewOnly': pane.invController.viewOnly,
                  'multiSelect': bool(pane.scroll.multiSelect),
                  'menu': [label_of(entry) for entry in pane.GetContainerMenu()]})
    selections = [held, [item for item in held if item.typeID != const.typePlex]]
    if len(held) > 2:
        selections.append([held[0], held[-1]])
    seen = set()
    for selected in selections:
        ids = tuple(item.itemID for item in selected)
        if len(ids) < 2 or ids in seen:
            continue
        seen.add(ids)
        selection_menus.append({'owner': owner, 'types': [item.typeID for item in selected],
                                'items': list(ids), 'menu': [
                                    {'label': label_of(entry), 'count': entry.quantity, 'text': entry.GetText()}
                                    for entry in parsed_menu(selected) if entry and label_of(entry)]})
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
    'selectionMenus': selection_menus,
    'panes': panes,
    'plex': plex,
    'controls': [GetByLabel(label) for label in ('UI/PVPTrade/OfferMoney', 'UI/PVPTrade/Accept', 'UI/Common/Buttons/Cancel')],
}
