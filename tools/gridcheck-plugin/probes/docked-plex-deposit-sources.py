"""Read native PLEX menu eligibility and deposit routing without writing inventory."""
from types import FunctionType

from eve.client.script.ui.services.menuSvcExtras.menuFunctions import RedeemCurrency
from eveservices.menu import GetMenuService
from inventorycommon import const
from localization import GetByLabel
from menucheckers.itemCheckers import ItemChecker
from utillib import KeyVal

docked_id = session.stationid or session.structureid
if not docked_id:
    raise RuntimeError('Dock at an NPC station or an Upwell structure')

container_id = 970000001
trade_id = 970000002
safety_id = 970000003
inner_id = 970000005
trade_inner_id = 970000006
safety_inner_id = 970000007
places = {
    container_id: KeyVal(itemID=container_id, locationID=docked_id, typeID=23),
    trade_id: KeyVal(itemID=trade_id, locationID=docked_id, typeID=const.typeTradeSession),
    safety_id: KeyVal(itemID=safety_id, locationID=docked_id, typeID=const.typeAssetSafetyWrap),
    inner_id: KeyVal(itemID=inner_id, locationID=container_id, typeID=23),
    trade_inner_id: KeyVal(itemID=trade_inner_id, locationID=trade_id, typeID=23),
    safety_inner_id: KeyVal(itemID=safety_inner_id, locationID=safety_id, typeID=23),
}


class ProjectedInventory:
    def __init__(self, item):
        self.item = item

    def GetItem(self):
        return self.item


class ProjectedServices:
    def __init__(self):
        self.deposit = None

    def GetService(self, name):
        if name == 'invCache':
            return self
        return sm.GetService(name)

    def GetInventoryFromId(self, location_id):
        return ProjectedInventory(places.get(location_id))

    def GetInventoryMgr(self):
        return self

    def DepositPlexToVault(self, location_id, item_id, quantity, invoice):
        self.deposit = [location_id, item_id, quantity, invoice]


def label_of(entry):
    if hasattr(entry, 'GetLabelPath'):
        return entry.GetLabelPath()
    if isinstance(entry, (list, tuple)) and entry:
        return getattr(entry[0], 'labelPath', entry[0] if isinstance(entry[0], basestring) else None)
    return None


other_station = 60003760 if session.stationid != 60003760 else 60003754
services = ProjectedServices()
redeem = FunctionType(RedeemCurrency.__code__, dict(RedeemCurrency.__globals__, sm=services))
cases = [
    ('local-hangar', docked_id, const.groupCurrency),
    ('remote-hangar', other_station, const.groupCurrency),
    ('owned-container', container_id, const.groupCurrency),
    ('owned-inner-container', inner_id, const.groupCurrency),
    ('trade', trade_id, const.groupCurrency),
    ('trade-inner-container', trade_inner_id, const.groupCurrency),
    ('asset-safety', safety_id, const.groupCurrency),
    ('asset-safety-inner-container', safety_inner_id, const.groupCurrency),
    ('vault-item', docked_id, const.groupCurrency),
    ('fake-item', docked_id, const.groupCurrency),
    ('non-currency', docked_id, 18),
]
rows = []
for name, location_id, group_id in cases:
    item = KeyVal(itemID=970000004, typeID=const.typePlex if group_id == const.groupCurrency else 34,
                  groupID=group_id, locationID=location_id, ownerID=session.charid, stacksize=7)
    if name == 'vault-item':
        item.isInPlexVault = True
    elif name == 'fake-item':
        item.itemID = const.minFakeItem
    checker = ItemChecker(item, session, services)
    offer = checker.OfferRedeemCurrency()
    services.deposit = None
    if offer:
        redeem(item, item.stacksize)
    rows.append({'source': name, 'location': location_id, 'offer': offer, 'deposit': services.deposit})

live_hangar = []
if session.structureid:
    from eve.client.script.environment.invControllers import StructureItemHangar

    label_path = 'UI/Inventory/ItemActions/RedeemCurrency'
    for item in StructureItemHangar(itemID=session.structureid).GetItems():
        if item.typeID != const.typePlex:
            continue
        menu = [label for label in map(label_of, GetMenuService().InvItemMenu(item)) if label]
        offer = label_path in menu
        eligible = ItemChecker(item).OfferRedeemCurrency()
        services.deposit = None
        if offer:
            redeem(item, item.stacksize)
        live_hangar.append({'item': item.itemID, 'location': item.locationID, 'flag': item.flagID,
                            'quantity': item.stacksize, 'eligible': eligible, 'offer': offer,
                            'menu': menu, 'deposit': services.deposit})

result = {'pilot': session.charid, 'station': session.stationid, 'structure': session.structureid,
          'rows': rows, 'liveHangar': live_hangar, 'label': GetByLabel('UI/Inventory/ItemActions/RedeemCurrency')}
