from raffles.client.details.fanfare.controller import FanfareController
from raffles.client.localization import Text
from raffles.client.raffle import Raffle
from utillib import KeyVal

service = sm.GetService('raffleSvc')
pick = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(pick.raffle_id), lambda row: None)
prior = bool(raffle.is_winner_unseen)
try:
    first = KeyVal(owner_id=session.charid, number=0)
    winning = KeyVal(owner_id=session.charid, number=1)
    raffle.sold_tickets = [first, winning]
    raffle.update_winner_seen(False)
    raffle.update_winning_ticket(winning)
    unseen = bool(raffle.is_winner_unseen)
    controller = FanfareController(raffle)
    order = controller.get_decrypting_order()
    initial = controller.highlighted_ticket_count
    for slot in order:
        controller.decrypt(slot)
    remaining = controller.highlighted_ticket_count
    controller.update_winner_seen()
    report = dict(station=session.stationid, unseen=unseen, order=order, initial=initial, remaining=remaining,
                  winner=bool(controller.is_winner), seen=not raffle.is_winner_unseen,
                  show=Text.card_show_winner(), skip=Text.skip())
finally:
    raffle.update_winner_seen(not prior)
result = report
