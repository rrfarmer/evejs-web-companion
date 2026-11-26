from copy import deepcopy
from eveui.autocomplete.item.suggestion import ItemTypeSuggestion, ItemGroupSuggestion, ItemCategorySuggestion
from localization import GetByLabel
from raffles.client.browse.filter_controller import FilterController, allowed_categories, default_settings
from signals import Signal

filters = FilterController.__new__(FilterController)
filters.on_change = Signal()
filters._active_settings = deepcopy(default_settings)
filters._current_settings = deepcopy(default_settings)
filters._save_filter = lambda: None
filters.ticket_count = (16, 48)
visits = []
for suggestion in (ItemTypeSuggestion(587), ItemGroupSuggestion(25), ItemCategorySuggestion(6), None):
    filters.item_suggestion = suggestion
    visits.append(dict(name=suggestion.name if suggestion else None, query=filters.get()))
result = dict(station=session.stationid, visits=visits, categories=allowed_categories,
              label=GetByLabel('UI/HyperNet/FilterItemLabel'))
