import eveui
import inventorycommon.const as invconst
from raffles.client.create.controller import CreatePageController
from raffles.client.create.drag_drop_area import DragDropArea
from raffles.common.raffle_data import RaffleCreationData

item = type('Stack', (object,), dict(typeID=34, itemID=123, ownerID=session.charid,
            flagID=invconst.flagHangar, locationID=session.stationid, singleton=0,
            quantity=378, stacksize=378))()
controller = CreatePageController.__new__(CreatePageController)
controller._item = item
area = DragDropArea.__new__(DragDropArea)
area._controller = controller
area.quantity_cont = type('QuantityContainer', (object,), {})()
area._update_quantity_cont()
request = RaffleCreationData(session.charid, item.locationID, None, 456, item.locationID,
                             item.itemID, item.typeID, 8, 875000, None)
result = dict(station=session.stationid, size=item.stacksize, valid=controller.validate_item(item) is None,
              activeHint=area.quantity_cont.state == eveui.State.normal, hint=area.quantity_cont.hint,
              itemID=request.item_id, fields=sorted(vars(request)))
