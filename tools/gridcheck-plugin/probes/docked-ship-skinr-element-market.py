import base64
import json
import sys
import zlib
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from localization import GetByLabel

from eve.client.script.ui.cosmetics.ship.pages.collection import componentLicenseInfo

rows = {}
for component_id, data in sorted(ComponentsDataLoader.get_components_data().items()):
    if not data.published:
        continue
    limited = next((item.type_id for item in data.component_item_data_by_type_id.values()
                    if item.license_type == componentLicenseInfo.ComponentLicenseType.LIMITED and item.type_id), None)
    shade = data.color_shade_sort_index
    rows[component_id] = [None if shade == sys.maxint else shade, limited]

result = dict(station=session.stationid, count=len(rows),
              sample={id: rows[id] for id in (53, 105, 1349, 179)},
              labels=[GetByLabel(label) for label in ('UI/Common/ColorShade', 'UI/Common/ColorShadeReversed',
                                                     'UI/Inventory/ItemActions/ViewTypesMarketDetails')],
              catalogue=base64.b64encode(zlib.compress(json.dumps(rows, separators=(',', ':')), 9)))
