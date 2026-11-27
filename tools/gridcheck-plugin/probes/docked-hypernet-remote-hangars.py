import inventorycommon.const as invconst
from raffles.client.create.controller import CreatePageController
from raffles.common.const import TOKEN_TYPE_ID
from raffles.common.raffle_data import RaffleCreationData

class HangarItem(object):
    def __init__(self, item_id, type_id, location_id):
        self.itemID = item_id
        self.typeID = type_id
        self.locationID = location_id
        self.ownerID = session.charid
        self.flagID = invconst.flagHangar
        self.singleton = 0

controller = CreatePageController.__new__(CreatePageController)
prize = HangarItem(123, 587, 60003760)
cores = HangarItem(456, TOKEN_TYPE_ID, 60003757)
draft = RaffleCreationData(session.charid, prize.locationID, None, cores.itemID,
                           cores.locationID, prize.itemID, prize.typeID, 8, 875000, None)
result = dict(station=session.stationid, prizeStation=draft.location_id, coreStation=draft.token_location_id,
              prizeError=controller.validate_item(prize), coreError=controller.validate_token(cores),
              prizeName=cfg.evelocations.Get(prize.locationID).locationName,
              coreName=cfg.evelocations.Get(cores.locationID).locationName)
