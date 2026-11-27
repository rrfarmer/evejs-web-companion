import blue
from raffles.client.localization import Text
from raffles.client.window import RaffleWindow

service = sm.GetService('raffleSvc')
offer = service.grab({}, {})[0]
window = RaffleWindow.Open(raffle_id=offer.raffle_id)
try:
    def observed_page():
        return next((child for child in window.content_container.children
                     if child.__class__.__name__ == 'DetailsPage' and child._raffle), None)
    page = observed_page()
    for attempt in range(40):
        if page:
            break
        blue.pyos.synchro.SleepWallclock(200)
        page = observed_page()
    detail = page._raffle
    data = dict(station=session.stationid, id=detail.raffle_id, item=detail.item_name,
                owner=detail.owner_id, location=detail.location_id, system=detail.solar_system_id,
                price=detail.ticket_price, tickets=detail.ticket_count, sold=detail.tickets_sold_count,
                page=page.__class__.__name__, panel=page.children[0].__class__.__name__,
                selectedTab=bool(window.header.tab_group.GetSelectedTab()),
                labels=[Text.page_title_details(), Text.tickets(), Text.ticket_price(),
                        Text.location(), Text.created_by(), Text.show_only_available()])
finally:
    window.Close()
result = data
