import blue
from raffles.client.details.ticket import Ticket, TicketController
from raffles.client.localization import Text
from raffles.client.raffle import Raffle

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(offer.raffle_id), lambda row: None)
controller = TicketController(raffle, 0)
attempts = []
controller.buy = lambda: attempts.append(controller.number)
ticket = Ticket(parent=uicore.layer.main)
try:
    ticket.set_ticket_controller(controller)
    available = ticket._get_enabled()
    ticket.OnClick()
    blue.pyos.synchro.SleepWallclock(50)
    first = (bool(ticket._in_confirm_state), len(attempts))
    for attempt in range(20):
        if ticket._confirm_state_ready:
            break
        blue.pyos.synchro.SleepWallclock(50)
    ready = bool(ticket._confirm_state_ready)
    ticket.OnClick()
    confirmed = list(attempts)
    controller.owner_id = session.charid
    enabled_after = ticket._get_enabled()
    ticket.OnClick()
    data = dict(station=session.stationid, available=bool(available), first=first, ready=ready,
                confirmed=confirmed, enabledAfter=bool(enabled_after), final=attempts,
                confirmLabel=Text.confirm_purchase())
finally:
    ticket.Close()
result = data
