import base64
import json
import zlib
import evegraphics.utils as gfxutils
from cosmetics.client.ships.skins.live_data.component_instance import build_config_proto_from_component_instance
from cosmetics.client.ships.skins.live_data.skin_design import SkinDesign
from cosmetics.client.ships.skins.static_data.hull_type_projections import get_projections_by_hull_type_name
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader, projection_type_from_fsd
from cosmetics.common.ships.skins.static_data.slot import SlotsDataLoader

slots = SlotsDataLoader.get_slots_by_id()
components = ComponentsDataLoader.GetData()
catalogue = dict(
    slots=[[slot, slots[slot].name, list(slots[slot].allowed_design_component_categories)] for slot in (5, 6, 7, 8)],
    components=[[key, row.name, list(row.disallowed_slots), row.resource_file, row.icon_file,
                 projection_type_from_fsd(row.projection_type_u), projection_type_from_fsd(row.projection_type_v)]
                for key, row in sorted(components.items())
                if row.published and row.category == 2 and row.associated_type_ids and row.resource_file],
    scales={name: projection.transformLayer1.scaling[0] for name, projection in get_projections_by_hull_type_name().items()})

design = SkinDesign(session.charid)
design.ship_type_id = 32880
sample = next(row for row in catalogue['components'] if 5 not in row[2])
pattern = design.fit_slot(5, sample[0])
model = sm.GetService('sofService').spaceObjectFactory.BuildFromDNA(gfxutils.BuildSOFDNAFromTypeID(32880))
pattern.ellipsoid_center = model.shapeEllipsoidCenter
pattern.ellipsoid_radii = model.shapeEllipsoidRadius
pattern.apply_user_authored_values()
wire = build_config_proto_from_component_instance(pattern).pattern.configuration
result = dict(station=session.stationid, ship=32880, component=sample[0],
              name=ComponentsDataLoader.get_component_data(sample[0]).name,
              slot=SlotsDataLoader.get_slot_data(5).name, materialSlot=SlotsDataLoader.get_slot_data(6).name,
              position=list(pattern.position), rotation=list(pattern.rotation), scaling=list(pattern.scaling),
              projection=pattern.get_projection_areas(), mirrored=wire.mirrored,
              catalogue=base64.b64encode(zlib.compress(json.dumps(catalogue, separators=(',', ':')), 9)))
