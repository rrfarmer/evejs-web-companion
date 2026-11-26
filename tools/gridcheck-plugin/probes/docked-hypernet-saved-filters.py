from copy import deepcopy
from localization import GetByLabel
from raffles.client.browse.filter_controller import FilterController, default_settings
from raffles.client.widget import saved_filter_combo as widget
from signals import Signal

class MemorySettings(object):
    def __init__(self):
        self.data = {}
        self.char = self
        self.ui = self

    def Get(self, key):
        value = self.data.get(key)
        if value is not None and 'version' not in value:
            return dict(version=1, filters=value)
        return value

    def Set(self, key, value):
        self.data[key] = value

filters = FilterController.__new__(FilterController)
filters.on_change = Signal()
filters._active_settings = deepcopy(default_settings)
filters._current_settings = deepcopy(default_settings)
filters._save_filter = lambda: None
originals = {key: getattr(widget, key, None) for key in
             ('settings', 'prompt_filter_name', 'prompt_override_filter', 'prompt_delete_filter')}
try:
    widget.settings = MemorySettings()
    controller = widget.SaveFilterController(filters, 'raffles_browse_saved_filters')
    filters.solar_system_id = session.solarsystemid2
    filters.meta_group_id = 2
    widget.prompt_filter_name = lambda: 'Tech II nearby'
    widget.prompt_override_filter = lambda name: False
    widget.prompt_delete_filter = lambda name: False
    controller.save_current_filter()
    saved_selection = controller.selected_filter_name
    filters.reset_filter()
    after_reset = controller.selected_filter_name
    controller.selected_filter_name = saved_selection
    reapplied = filters.get()
    filters.meta_group_id = 4
    controller.save_current_filter()
    override_cancelled = controller.selected_filter_name is None
    widget.prompt_override_filter = lambda name: True
    controller.save_current_filter()
    controller.delete(saved_selection)
    delete_cancelled = len(controller.saved_filters) == 1
    widget.prompt_delete_filter = lambda name: True
    controller.delete(saved_selection)
    result = dict(station=session.stationid, limit=controller.saved_filter_count_max, saved=saved_selection,
                  reset=after_reset, reapplied=reapplied, override_cancelled=override_cancelled,
                  delete_cancelled=delete_cancelled, remaining=len(controller.saved_filters), active=filters.get(),
                  labels=[GetByLabel('UI/HyperNet/' + key) for key in
                          ('SavedFilters', 'SaveFilterHint', 'DeleteSavedFilter', 'NoFilterSelected', 'FilterNamePromptCaption', 'FilterNamePromptHint')])
finally:
    for key, value in originals.items():
        if value is None:
            delattr(widget, key)
        else:
            setattr(widget, key, value)
