import blue
from raffles.client.link import handle_raffle_link, get_link_hint
from raffles.client.raffle import Raffle
from raffles.client.window import RaffleWindow

service = sm.GetService('raffleSvc')
data = service.grab({}, {})[0]
raffle = Raffle(service.get_raffle(data.raffle_id), lambda row: None)
drag = raffle.get_drag_data()
link = drag.get_link()
handle_raffle_link(link.url)
window = RaffleWindow.GetIfOpen()
try:
    for attempt in range(30):
        page = next((child for child in window.content_container.children
                     if child.__class__.__name__ == 'DetailsPage' and child._raffle), None)
        if page:
            break
        blue.pyos.synchro.SleepWallclock(100)
    observed = dict(station=session.stationid, id=drag.raffleID, url=link.url, text=link.text,
                    hint=get_link_hint(link.url), detail=page._raffle.raffle_id,
                    selectedTab=bool(window.header.tab_group.GetSelectedTab()))
finally:
    window.Close()
result = observed
