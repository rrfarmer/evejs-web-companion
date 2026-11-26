from copy import deepcopy
from eveui.autocomplete.item.suggestion import ItemTypeSuggestion, ItemGroupSuggestion, ItemCategorySuggestion
from localization import GetByLabel
from raffles.client.browse.filter_controller import FilterController, default_settings
from raffles.common.const import BlueprintType
from signals import Signal

filters = FilterController.__new__(FilterController)
filters.on_change = Signal()
filters._active_settings = deepcopy(default_settings)
filters._current_settings = deepcopy(default_settings)
filters._save_filter = lambda: None
item = ItemTypeSuggestion(691)
visits = []
for suggestion, subtype in ((item, BlueprintType.all), (item, BlueprintType.original),
                            (ItemGroupSuggestion(item.group_id), BlueprintType.copy),
                            (ItemTypeSuggestion(587), None), (ItemCategorySuggestion(9), None)):
    filters.item_suggestion = suggestion
    if subtype is not None:
        filters.blueprint_type = subtype
    visits.append(dict(is_blueprint=filters.is_blueprint, query=filters.get()))
result = dict(station=session.stationid, type_id=item.type_id, group_id=item.group_id,
              options=[(int(value), name) for name, value in filters.blueprint_options],
              label=GetByLabel('UI/HyperNet/FilterBlueprintLabel'), visits=visits)
