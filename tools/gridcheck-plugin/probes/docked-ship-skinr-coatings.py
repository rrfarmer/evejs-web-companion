import base64
import json
import trinity
import zlib
from cosmetics.client.ships.skins.live_data.component_instance import build_config_proto_from_component_instance
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader, ComponentsPostProcessDataLoader
from cosmetics.common.ships.skins.static_data.slot import SlotsDataLoader
from cosmetics.common.ships.skins.static_data.slot_configuration import SlotConfigurationsDataLoader
from eve.client.script.environment.spaceObject.cosmeticsConst import AREA_MAPS

slot_ids = (1, 2, 3, 4)
slots = SlotsDataLoader.get_slots_by_id()
swatches = ComponentsPostProcessDataLoader.GetData()
components = ComponentsDataLoader.GetData()
catalogue = dict(
    slots=[[slot_id, slots[slot_id].name, list(slots[slot_id].allowed_design_component_categories)] for slot_id in slot_ids],
    configurations=[[row.priority, bool(row.allow_all_ships), list(row.ships or []), list(row.config)]
                    for key, row in sorted(SlotConfigurationsDataLoader.GetData().items())],
    components=[[key, row.name, row.category, list(row.disallowed_slots), swatches.get(key, ''), row.resource_file]
                for key, row in sorted(components.items())
                if row.published and row.category in (1, 3) and row.associated_type_ids and row.resource_file],
    areas={str(key): [row.get(slot) for slot in slot_ids] for key, row in AREA_MAPS.items()})

design = SkinDesign(session.charid)
design.ship_type_id = 32880
sample = next(row for row in catalogue['components'] if row[2] in slots[1].allowed_design_component_categories and 1 not in row[3])
design.fit_slot(1, sample[0])
configuration = build_config_proto_from_component_instance(design.get_fitted_component_instance(1)).coating.configuration
fields = ('diffuse_color', 'dust_diffuse_color', 'fresnel_color', 'gloss')
material = trinity.Load(sample[5])
result = dict(station=session.stationid, ship=design.ship_type_id, component=sample[0],
              name=ComponentsDataLoader.get_component_data(sample[0]).name, material=material.name,
              slot=SlotsDataLoader.get_slot_data(1).name,
              values={field: [getattr(getattr(configuration, field), axis) for axis in 'xyzw'] for field in fields},
              fitted=design.has_fitted_components(), count=len(catalogue['components']),
              catalogue=base64.b64encode(zlib.compress(json.dumps(catalogue, separators=(',', ':')), 9)))
