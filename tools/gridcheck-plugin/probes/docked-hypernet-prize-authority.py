import evetypes
from raffles.client.create.controller import CreatePageController
from raffles.common.util import is_type_valid_for_hypernet

types = (34, 587, 691, 1230, 44992, 52568, 53530, 60033, 84434)
ids = (36, 133, 134, 142)
lists = dict((key, evetypes.GetTypeIDsByListID(key)) for key in ids)
controller = CreatePageController.__new__(CreatePageController)
rows = []
for type_id in types:
    item = type('Prize', (object,), dict(typeID=type_id, singleton=1))()
    rows.append(dict(typeID=type_id, prize=is_type_valid_for_hypernet(type_id),
                     singleton=controller._validate_singleton(item),
                     lists=[key for key in ids if type_id in lists[key]]))
dynamic = sorted(type_id for type_id in evetypes.Iterate()
                 if evetypes.IsDynamicType(type_id) and is_type_valid_for_hypernet(type_id))
result = dict(station=session.stationid, rows=rows, dynamic=dynamic)
