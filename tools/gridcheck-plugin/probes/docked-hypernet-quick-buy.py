import blue
import eveui
from raffles.client.raffle import Raffle
from raffles.client.widget.quick_buy_button import QuickBuyButton

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(offer.raffle_id), lambda row: None)
received = []
raffle.buy_random_tickets = received.append
button = QuickBuyButton(parent=uicore.layer.main, align=eveui.Align.top_left, raffle=raffle)
try:
    initial = button._not_hovering_check()
    button.card_enter()
    hovered = not button._not_hovering_check()
    button.OnClick()
    blue.pyos.synchro.SleepWallclock(50)
    first = list(received)
    for attempt in range(30):
        if button._confirm_state_ready:
            break
        blue.pyos.synchro.SleepWallclock(50)
    ready = button._confirm_state_ready
    button.OnClick()
    blue.pyos.synchro.SleepWallclock(50)
    raffle.update_my_tickets(1)
    button.tickets_sold()
    button.card_exit()
    owned_label = button.text_label.text
    persists = not button._not_hovering_check()
    raffle.is_finished = True
    button.OnClick()
    data = dict(station=session.stationid, id=offer.raffle_id, hiddenInitially=bool(initial),
                visibleOnHover=bool(hovered), first=first, ready=bool(ready), submitted=list(received),
                ownedLabel=unicode(owned_label), visibleWhenOwned=bool(persists))
finally:
    button.Close()
result = data
