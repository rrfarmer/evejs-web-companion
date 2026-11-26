from carbonui.primitives.container import Container
from cosmetics.client.ships.skins.live_data.paginationController import PaginationController
from eve.client.script.ui.cosmetics.ship.pages.store.componentBrowser import MAX_NUM_PER_PAGE
from eve.client.script.ui.cosmetics.ship.pages.store.paginationButtons import PaginationButtons

controller = PaginationController()
controller.clear(list(range(100, 143)), MAX_NUM_PER_PAGE)
parent = Container()
buttons = PaginationButtons(controller, parent=parent)
visits = []

def select_page(page):
    entries = controller.get_page(page)
    visits.append(dict(page=page + 1, count=len(entries), first=entries[0], last=entries[-1],
                       disabled=[bool(button.disabled) for button in
                                 (buttons.first_page_btn, buttons.prev_page_btn, buttons.next_page_btn)]))

try:
    buttons.on_page_selected.connect(select_page)
    select_page(0)
    buttons.on_next_page_btn()
    buttons.on_next_page_btn()
    buttons.on_prev_page_btn()
    buttons.on_first_page_btn()
    observations = dict(station=session.stationid, size=MAX_NUM_PER_PAGE, visits=visits,
                        hints=[button.hint for button in
                               (buttons.first_page_btn, buttons.prev_page_btn, buttons.next_page_btn)])
finally:
    buttons.on_page_selected.disconnect(select_page)
    controller.on_page_num_changed.disconnect(buttons._on_page_num_changed)
    parent.Close()

result = observations
