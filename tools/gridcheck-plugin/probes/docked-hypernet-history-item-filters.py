from copy import deepcopy
from eveui.autocomplete.item.suggestion import ItemTypeSuggestion, ItemGroupSuggestion, ItemCategorySuggestion
from localization import GetByLabel
from raffles.client.history.controller import HistoryPageController
from raffles.client.history.filter_controller import FilterController, default_settings

class Record(object):
    is_raffle_owner = True
    is_finished = False
    is_private = False
    ticket_count = 8
    ticket_price = 2000000

    def __init__(self, item, system, meta, copy):
        suggestion = ItemTypeSuggestion(item)
        self.type_id = item
        self.group_id = suggestion.group_id
        self.category_id = suggestion.category_id
        self.solar_system_id = system
        self.meta_group_id = meta
        self.is_blueprint_copy = copy

filters = FilterController.__new__(FilterController)
controller = HistoryPageController.__new__(HistoryPageController)
controller.filters = filters
records = [Record(691, 30000142, 1, True), Record(691, 30000144, 1, False),
           Record(688, 30000142, 1, False), Record(12068, 30000142, 2, False)]
visits = []
for selected in (dict(item_suggestion=ItemTypeSuggestion(691)),
                 dict(item_suggestion=ItemGroupSuggestion(105)),
                 dict(item_suggestion=ItemCategorySuggestion(9)),
                 dict(solar_system_id=30000144), dict(meta_group_id=2),
                 dict(item_suggestion=ItemCategorySuggestion(9), blueprint_type=2, solar_system_id=30000144),
                 dict(item_suggestion=ItemCategorySuggestion(9), solar_system_id=30000144)):
    filters._current_settings = deepcopy(default_settings)
    filters._current_settings.update(selected)
    visits.append([index for index, row in enumerate(records) if controller._filter_raffle(row)])
result = dict(station=session.stationid, visits=visits,
              labels=[GetByLabel('UI/HyperNet/' + key) for key in
                      ('FilterItemLabel', 'FilterLocationLabel', 'FilterMetaGroupLabel', 'FilterBlueprintLabel')])
