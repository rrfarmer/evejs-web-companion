import evetypes
import inventorycommon.const as invconst
from raffles.client.create.controller import CreatePageController
from raffles.common import util

controller = CreatePageController.__new__(CreatePageController)
class Item(object):
    def __init__(self, type_id, singleton, quantity):
        self.typeID = type_id
        self.ownerID = session.charid
        self.flagID = invconst.flagHangar
        self.locationID = session.stationid
        self.singleton = singleton
        self.quantity = quantity

samples = [(587, 0, 1), (587, 1, -1), (691, 1, -1), (691, 2, -2), (34, 0, 100),
           (1230, 0, 100), (44992, 0, 1), (60033, 0, 1), (53530, 0, 1), (52568, 0, 1)]
dynamic = next((type_id for type_id in evetypes.Iterate()
                if evetypes.IsDynamicType(type_id) and util.is_type_valid_for_hypernet(type_id)), None)
if dynamic is not None:
    samples.append((dynamic, 1, -1))
lists = dict((number, evetypes.GetTypeIDsByListID(number)) for number in (36, 133, 134, 142))
rows = []
for type_id, singleton, quantity in samples:
    item = Item(type_id, singleton, quantity)
    rows.append(dict(typeID=type_id, name=evetypes.GetName(type_id), singleton=singleton, quantity=quantity,
                     dynamic=evetypes.IsDynamicType(type_id), error=controller.validate_item(item),
                     lists=[number for number in sorted(lists) if type_id in lists[number]]))
result = dict(station=session.stationid, rows=rows)
