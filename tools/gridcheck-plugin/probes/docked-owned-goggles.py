from types import FunctionType

import blue
import evetypes

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    category = 'accessories/glasses'
    families = ('goggles_01', 'glasses_citadel_f01', 'glasses_citadel_m01', 'glasses_exo_f01', 'glasses_exo_m01')
    service = sm.GetService('character')
    clothing = sm.GetService('cc')
    method = service.GetAvailableTypesByCategory.__func__
    player_choices = FunctionType(method.func_code, dict(method.func_globals, ROLE_CONTENT=0),
                                  method.func_name, method.func_defaults, method.func_closure)
    stock = {}
    for row in cfg.paperdollResources:
        path = row.resPath.lower()
        if row.typeID is not None and any(path.startswith(category + '/' + family + '/types/') for family in families):
            stock[row.paperdollResourceID] = dict(typeID=row.typeID, name=evetypes.GetName(row.typeID))
    owned = clothing.GetMyApparel()
    counts = {}
    try:
        for projection in (False, True):
            clothing.availableTypeIDs = set(row['typeID'] for row in stock.values()) if projection else owned
            counts['owned' if projection else 'unowned'] = {
                gender: sorted(resource for resource, _, _ in player_choices(service, category, gender, 2) if resource in stock)
                for gender in ('female', 'male')
            }
    finally:
        clothing.availableTypeIDs = owned
    samples = []
    for gender, resources in ((0, (1065, 15671, 15971)), (1, (464, 15683, 15981))):
        pilot = next(char_id for char_id, info in iter_npc_characters()
                     if info.gender == gender and info.bloodlineID == 8)
        for resource in resources:
            dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[], colors=[], modifiers=[])
            try:
                window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
                for _ in range(80):
                    context = window.previewContainer.context
                    if context and context.character is not None and getattr(context, 'boundingBox', None):
                        break
                    blue.synchro.SleepWallclock(100)
                if not context or not getattr(context, 'boundingBox', None):
                    raise RuntimeError('Character preview did not report bounds')
                service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
                context.character.Update()
                context.character.WaitForUpdate()
                doll = context.character.doll
                meshes = [mesh for mesh in context.character.avatar.visualModel.meshes if 'glasses' in mesh.name.lower()]
                lens_effects = [area.effect.name for mesh in meshes for area in mesh.transparentAreas if area.effect]
                weights = doll.buildDataManager.GetMorphTargets()
                samples.append(dict(gender=gender, resource=resource, lens_effects=lens_effects,
                                    hair_fit=weights.get('pushhairglassesshape', 0)))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, stock=stock, counts=counts, samples=samples)


result = observe()
