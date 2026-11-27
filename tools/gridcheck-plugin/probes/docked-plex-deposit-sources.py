"""Read the native PLEX menu predicate for projected docked inventory rows."""
from inventorycommon import const
from localization import GetByLabel
from menucheckers.itemCheckers import ItemChecker
from utillib import KeyVal

if not session.stationid:
    raise RuntimeError('Dock at an NPC station to compare the two station hangars')

container_id = 970000001
trade_id = 970000002
safety_id = 970000003
inner_id = 970000005
trade_inner_id = 970000006
safety_inner_id = 970000007
places = {
    container_id: KeyVal(itemID=container_id, locationID=session.stationid, typeID=23),
    trade_id: KeyVal(itemID=trade_id, locationID=session.stationid, typeID=const.typeTradeSession),
    safety_id: KeyVal(itemID=safety_id, locationID=session.stationid, typeID=const.typeAssetSafetyWrap),
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
    def GetService(self, name):
        if name == 'invCache':
            return self
        return sm.GetService(name)

    def GetInventoryFromId(self, location_id):
        return ProjectedInventory(places.get(location_id))


other_station = 60003760 if session.stationid != 60003760 else 60003754
cases = [
    ('local-hangar', session.stationid, const.groupCurrency),
    ('remote-hangar', other_station, const.groupCurrency),
    ('owned-container', container_id, const.groupCurrency),
    ('owned-inner-container', inner_id, const.groupCurrency),
    ('trade', trade_id, const.groupCurrency),
    ('trade-inner-container', trade_inner_id, const.groupCurrency),
    ('asset-safety', safety_id, const.groupCurrency),
    ('asset-safety-inner-container', safety_inner_id, const.groupCurrency),
    ('vault-item', session.stationid, const.groupCurrency),
    ('fake-item', session.stationid, const.groupCurrency),
    ('non-currency', session.stationid, 18),
]
rows = []
for name, location_id, group_id in cases:
    item = KeyVal(itemID=970000004, typeID=const.typePlex if group_id == const.groupCurrency else 34,
                  groupID=group_id, locationID=location_id, ownerID=session.charid, stacksize=7)
    if name == 'vault-item':
        item.isInPlexVault = True
    elif name == 'fake-item':
        item.itemID = const.minFakeItem
    checker = ItemChecker(item, session, ProjectedServices())
    rows.append({'source': name, 'location': location_id, 'offer': checker.OfferRedeemCurrency()})

result = {'pilot': session.charid, 'station': session.stationid, 'rows': rows,
          'label': GetByLabel('UI/Inventory/ItemActions/RedeemCurrency')}
