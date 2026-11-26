from copy import deepcopy
from localization import GetByLabel
from raffles.client.history.controller import HistoryPageController
from raffles.client.history.filter_controller import FilterController, default_settings

class Record(object):
    def __init__(self, owner, finished, private):
        self.is_raffle_owner = owner
        self.is_finished = finished
        self.is_private = private
        self.ticket_price = 2000000 if owner else 100000
        self.ticket_count = 16 if private else 8

filters = FilterController.__new__(FilterController)
filters._current_settings = deepcopy(default_settings)
controller = HistoryPageController.__new__(HistoryPageController)
controller.filters = filters
records = [Record(bool(index & 4), bool(index & 2), bool(index & 1)) for index in range(8)]
keys = ('show_joined', 'show_created', 'show_active', 'show_finished', 'show_public', 'show_private')
visits = {}
for key in keys:
    filters._current_settings[key] = False
    visits[key] = [index for index, row in enumerate(records) if controller._filter_raffle(row)]
    filters._current_settings[key] = True
filters._current_settings.update(min_ticket_count=16, min_ticket_price=1000000)
combined = [index for index, row in enumerate(records) if controller._filter_raffle(row)]
result = dict(station=session.stationid, visits=visits, combined=combined,
              price=filters.ticket_price_increments, count=filters.ticket_count_increments,
              showing=GetByLabel('UI/HyperNet/ShowingFiltered', filtered_count=4, total_count=8),
              labels=[GetByLabel('UI/HyperNet/' + label) for label in
                      ('ShowJoined', 'ShowCreated', 'ShowActive', 'ShowFinished', 'ShowPublic', 'ShowPrivate')])
