from copy import deepcopy
from raffles.client.history.filter_controller import FilterController, default_settings
from raffles.client.widget import saved_filter_combo as widget
from signals import Signal

class MemorySettings(object):
    def __init__(self):
        self.data = {}
        self.char = self
        self.ui = self

    def Get(self, key):
        value = self.data.get(key)
        return dict(version=1, filters=value) if value is not None else None

    def Set(self, key, value):
        self.data[key] = value

filters = FilterController.__new__(FilterController)
filters._current_settings = deepcopy(default_settings)
filters._sorting = (None, False)
filters._save_filter = lambda: None
filters._save_sorting = lambda: None
filters.on_change = Signal()
filters.on_sorting_changed = Signal()
originals = {key: getattr(widget, key, None) for key in ('settings', 'prompt_filter_name', 'prompt_delete_filter')}
try:
    widget.settings = MemorySettings()
    widget.prompt_filter_name = lambda: 'History fixture'
    widget.prompt_delete_filter = lambda name: True
    history = widget.SaveFilterController(filters, 'raffles_history_saved_filters')
    browse = widget.SaveFilterController(filters, 'raffles_browse_saved_filters')
    filters.sort_id = 'ticket_price'
    filters.sort_direction = False
    can_save_sort_only = not history.is_filter_default
    sort_only = dict(sort=filters.sorting, controller_default=filters.is_default,
                     saved_alias=history.current_filter_settings.get('sorting'))
    reopened = widget.SaveFilterController(filters, 'raffles_history_saved_filters')
    reopen_can_save_sort_only = not reopened.is_filter_default
    filters.edit_filter_many(('show_finished', False))
    combined_before_save = history.current_filter_settings.get('sorting')
    history.save_current_filter()
    stored = history.saved_filters['History fixture'].get('sorting')
    filters.sort_direction = True
    selected_after_sort = history.selected_filter_name
    after_reverse = history.current_filter_settings.get('sorting')
    widget.prompt_filter_name = lambda: 'Second fixture'
    history.save_current_filter()
    after_second_save = filters.sorting
    filters.edit_filter_many(('show_finished', True))
    selected_after_filter = history.selected_filter_name
    history.selected_filter_name = 'History fixture'
    restored = dict(sort=filters.sorting, finished=filters.get_setting('show_finished'))
    history.delete('History fixture')
    history.delete('Second fixture')
    result = dict(station=session.stationid, can_save_sort_only=can_save_sort_only, sort_only=sort_only,
                  reopen_can_save_sort_only=reopen_can_save_sort_only, combined_before_save=combined_before_save,
                  stored=stored, after_reverse=after_reverse, after_second_save=after_second_save,
                  selected_after_sort=selected_after_sort, selected_after_filter=selected_after_filter,
                  restored=restored, after_delete=filters.sorting, history=len(history.saved_filters),
                  browse=len(browse.saved_filters), limit=history.saved_filter_count_max)
finally:
    for key, value in originals.items():
        if value is None:
            delattr(widget, key)
        else:
            setattr(widget, key, value)
