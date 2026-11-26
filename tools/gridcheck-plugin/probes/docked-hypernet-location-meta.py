from copy import deepcopy
from localization import GetByLabel
from raffles.client.browse.filter_controller import FilterController, default_settings
from signals import Signal
import metaGroups

filters = FilterController.__new__(FilterController)
filters.on_change = Signal()
filters._active_settings = deepcopy(default_settings)
filters._current_settings = deepcopy(default_settings)
filters._save_filter = lambda: None
visits = []
filters.solar_system_id = session.solarsystemid2
visits.append(filters.get())
filters.meta_group_id = 2
visits.append(filters.get())
filters.solar_system_id = None
visits.append(filters.get())
filters.reset_filter()
visits.append(filters.get())
result = dict(station=session.stationid, system=session.solarsystemid2, visits=visits,
              options=sorted((group.name, group.id) for group in metaGroups.iter_meta_groups()),
              labels=[GetByLabel(key) for key in ('UI/HyperNet/FilterLocationLabel', 'UI/HyperNet/FilterMetaGroupLabel', 'UI/Common/All')])
