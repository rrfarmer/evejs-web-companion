from raffles.client.create.statistics import Statistics
from raffles.client.localization import Text
from raffles.common.const import TOKEN_TYPE_ID

service = sm.GetService('raffleSvc')
keys = ['historic_count', 'historic_min', 'historic_max', 'historic_average',
        'active_count', 'active_min', 'active_max', 'active_average']
results = []
for type_id in (587, TOKEN_TYPE_ID):
    statistics = service.get_type_statistics(type_id)
    display = Statistics.__new__(Statistics)
    display._controller = type('Controller', (object,), {'statistics': statistics})()
    results.append(dict(typeID=type_id, values=dict((key, statistics[key]) for key in keys),
                        displayed=dict((key, display._format_price(key)) for key in keys if not key.endswith('_count'))))
result = dict(station=session.stationid, token=TOKEN_TYPE_ID, statistics=results,
              sections=[Text.historical_statistics(), Text.active_statistics()],
              measures=[Text.maximum_price(), Text.minimum_price(), Text.average_price()],
              acquisition=[Text.open_market(), Text.open_nes()])
