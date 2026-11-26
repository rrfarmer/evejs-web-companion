from eve.client.script.ui.shared.market.orders import OrderEntry
from utillib import KeyVal


def observe_order(issuer, station, system, type_id=34):
    order = KeyVal(charID=issuer, typeID=type_id, stationID=station, solarSystemID=system)
    entry = KeyVal(sr=KeyVal(node=KeyVal(order=order)), OnClick=lambda: None)
    entry.CancelOffer = lambda *args: None
    entry.ModifyPrice = lambda *args: None
    def describe(item):
        label = getattr(item, 'text', None)
        if label is None:
            label = item[0]
        label = getattr(label, 'path', label)
        return unicode(label)
    return dict(
        menu=[describe(item) for item in OrderEntry.GetMenu.im_func(entry) if item],
        drag=[node.typeID for node in OrderEntry.GetDragData.im_func(entry)])


result = dict(
    station=session.stationid,
    issuing=observe_order(session.charid, 60003760, 30000142),
    other=observe_order(session.charid + 1, 60003760, 30000142),
    system=observe_order(session.charid, 0, 30000142))
