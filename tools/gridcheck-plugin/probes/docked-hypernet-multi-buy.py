import blue
import eveui
from raffles.client.raffle import Raffle
from raffles.client.widget.multi_buy import MultiBuy

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(offer.raffle_id), lambda row: None)
received = []
owner = eveui.Button(parent=uicore.layer.main, align=eveui.Align.top_left, label='HyperNet probe')
purchase = MultiBuy(received.append, raffle)
try:
    purchase.open(owner)
    for attempt in range(30):
        if hasattr(purchase, 'buy_button'):
            break
        blue.pyos.synchro.SleepWallclock(50)
    field = purchase.ticket_amount_field
    empty = field.GetValue()
    field.SetValue(3)
    purchase._handle_ticket_amount()
    amount = purchase._ticket_amount
    total = purchase.total_price_label.text
    purchase.buy_button.OnClick()
    blue.pyos.synchro.SleepWallclock(50)
    first = list(received)
    for attempt in range(30):
        if purchase.buy_button._confirm_state_ready:
            break
        blue.pyos.synchro.SleepWallclock(50)
    ready = purchase.buy_button._confirm_state_ready
    purchase.buy_button.OnClick()
    blue.pyos.synchro.SleepWallclock(50)
    data = dict(station=session.stationid, count=raffle.tickets_remaining_count, empty=empty,
                amount=amount, price=raffle.ticket_price, total=total, ready=bool(ready),
                first=first, confirmed=list(received), closed=not purchase._open)
finally:
    purchase.close()
    owner.Close()
result = data
