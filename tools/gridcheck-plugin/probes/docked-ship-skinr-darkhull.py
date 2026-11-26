import evegraphics.effects as effects
import evegraphics.utils as gfxutils
import evetypes
from cosmetics.common.ships.skins.static_data.component import ComponentsDataLoader
from cosmetics.common.ships.skins.static_data.slot_configuration import SlotConfigurationsDataLoader
from cosmetics.common.ships.skins.static_data.slot_name import SlotID
from eve.client.script.environment.spaceObject.cosmeticsConst import AREA_MAPS
from eve.client.script.environment.spaceObject.cosmeticsManager import CosmeticsManager
from fsdBuiltData.common.graphicIDs import GetSofHullName
from trinity import EveSOFDataAreaType

manager = CosmeticsManager()
darkhulls = {}
for hull in manager.sofDB.hull:
    indices = [area.index for area in hull.opaqueAreas if area.areaType == EveSOFDataAreaType.Darkhull]
    if indices:
        darkhulls[hull.name] = indices

coating_id = 1349
path = ComponentsDataLoader.get_component_data(coating_id).resource_file_path
factory = sm.GetService('sofService').spaceObjectFactory
observations = {}

def inspect_effects(mesh_areas):
    return [dict(index=area.index, mask=next(res.resourcePath for res in area.effect.resources if res.name == 'MaterialMap'),
                 materials=[[effects.GetParameterValue(area.effect, 'Mtl%d%s' % (slot, key))
                             for key in ('DiffuseColor', 'DustDiffuseColor', 'FresnelColor', 'Gloss')]
                            for slot in range(1, 5)]) for area in mesh_areas]

for type_id in sorted(evetypes.GetTypeIDsByCategory(6)):
    if not evetypes.IsPublished(type_id):
        continue
    indices = darkhulls.get(GetSofHullName(evetypes.GetGraphicID(type_id)))
    channel = AREA_MAPS.get(evetypes.GetFactionID(type_id), {}).get(SlotID.TECH_AREA)
    if not indices or not channel or channel in observations:
        continue
    config = SlotConfigurationsDataLoader.get_for_ship(type_id)
    if not config or SlotID.TECH_AREA not in config.slots:
        continue
    model = factory.BuildFromDNA(gfxutils.BuildSOFDNAFromTypeID(type_id))
    areas = [area for area in model.mesh.opaqueAreas if area.index in indices]
    if not areas:
        continue
    manager.SetTypeID(type_id)
    manager.SetModel(model)
    initial = inspect_effects(areas)
    manager.SetMaterialOnArea(path, SlotID.TECH_AREA)
    fitted = inspect_effects(areas)
    manager.SetMaterialOnArea('', SlotID.TECH_AREA)
    observations[channel] = dict(typeID=type_id, name=evetypes.GetName(type_id), dna=model.dna,
                                 default=manager.GetDefaultMaterialForSlot(SlotID.TECH_AREA),
                                 initial=initial, fitted=fitted, cleared=inspect_effects(areas))

result = dict(station=session.stationid, coating=coating_id, channels=observations)
