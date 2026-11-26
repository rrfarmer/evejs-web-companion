from copy import deepcopy
from localization import GetByLabel
from raffles.client.browse.filter_controller import FilterController, default_settings
from signals import Signal

filters = FilterController.__new__(FilterController)
filters.on_change = Signal()
filters._active_settings = deepcopy(default_settings)
filters._current_settings = deepcopy(default_settings)
filters._save_filter = lambda: None
visits = [filters.get()]
filters.ticket_price = (1000000, 10000000)
filters.ticket_count = (16, 48)
visits.append(filters.get())
filters.reset_filter()
visits.append(filters.get())

result = dict(station=session.stationid, visits=visits, price=filters.ticket_price_increments,
              count=filters.ticket_count_increments,
              labels={key: GetByLabel('UI/HyperNet/' + key) for key in ('TicketPrice', 'TicketCountLabel', 'Reset')})
