from raffles.client.create.controller import CreatePageController
from raffles.client.localization import Text
from raffles.common.const import TICKET_COUNT_POOL, TOKEN_TYPE_ID, RAFFLE_TAX_PERCENTAGE
from raffles.common.util import tokens_required

controller = CreatePageController.__new__(CreatePageController)
rows = []
for count in TICKET_COUNT_POOL:
    controller._ticket_count = count
    rows.append([count, controller._clamp_price(1001), controller._clamp_price(10000000000001)])
result = dict(station=session.stationid, tokenType=TOKEN_TYPE_ID, counts=list(TICKET_COUNT_POOL),
              tax=RAFFLE_TAX_PERCENTAGE, quotes=rows, tokens=tokens_required(100000000),
              create=Text.tab_create())
