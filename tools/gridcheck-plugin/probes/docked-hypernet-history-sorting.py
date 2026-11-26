from localization import GetByLabel
from raffles.client.history.controller import HistoryPageController
from raffles.client.history.filter_controller import FilterController, default_sort_direction, get_sort_options
from signals import Signal

class Record(object):
    def __init__(self, name, count, price, end_time, finished):
        self.item_name = name
        self.ticket_count = count
        self.ticket_price = price
        self.total_price = count * price
        self.end_time = end_time
        self.is_finished = finished
        self.requires_interaction = False

filters = FilterController.__new__(FilterController)
filters._sorting = (None, default_sort_direction[None])
filters._save_sorting = lambda: None
filters.on_sorting_changed = Signal()
controller = HistoryPageController.__new__(HistoryPageController)
controller.filters = filters
controller._my_raffles = [Record('Rifter', 8, 3, 6, False),
                          Record('Probe', 16, 1, 4, False),
                          Record('Venture', 8, 2, 2, True)]
visits = []
for label, key in get_sort_options():
    filters.sort_id = key
    initial = filters.sort_direction
    controller._sort_raffles()
    order = [row.item_name for row in controller._sorted_raffles]
    reverse = None
    if key:
        filters.sort_direction = not initial
        controller._sort_raffles()
        reverse = [row.item_name for row in controller._sorted_raffles]
    visits.append(dict(label=label, key=key, descending=initial, order=order, reverse=reverse))
filters.reset_sorting()
result = dict(station=session.stationid, visits=visits, reset=filters.sorting,
              label=GetByLabel('UI/Common/SortBy'), direction=GetByLabel('UI/HyperNet/SortDirection'))
