from localization import GetByLabel
from raffles.client.constants import RAFFLES_PER_PAGE
from raffles.client.window import RaffleWindow

service = sm.GetService('raffleSvc')
paths = ('WindowTitle', 'Refresh', 'NoRafflesFoundError', 'RemainingTickets', 'TicketPrice')
data = dict(station=session.stationid, available=bool(service.is_available), pageSize=RAFFLES_PER_PAGE,
            width=RaffleWindow.default_fixedWidth, height=RaffleWindow.default_fixedHeight,
            icon=RaffleWindow.default_iconNum,
            labels={path: GetByLabel('UI/HyperNet/' + path) for path in paths})
if service.is_available:
    window = RaffleWindow.Open()
    try:
        rows = service.grab({}, {})
        data['rows'] = [dict(id=row.raffle_id, type=row.type_id, price=row.ticket_price,
                             count=row.ticket_count, sold=row.sold_ticket_count) for row in rows[:12]]
        data['tabs'] = [dict(caption=tab[0], id=tab[3]) for tab in window.GetMainTabData()]
    finally:
        window.Close()

result = data
