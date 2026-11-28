import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow, ModifierRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    locations = {row.modifierKey: row.modifierLocationID for row in cfg.paperdollModifierLocations}
    resources = {(row.resGender, row.resPath.lower()): row.paperdollResourceID for row in cfg.paperdollResources}
    shape = 'pushhairglassesshape'
    samples = []
    for gender, style, glasses in ((0, 'hair_bob_02', 310), (1, 'hair_armycut_03', 200)):
        pilot = next(char_id for char_id, info in iter_npc_characters()
                     if info.gender == gender and info.bloodlineID == 8)
        hair = resources[gender, 'hair/%s/types/%s.type' % (style, style)]
        for equipped in (False, True):
            modifiers = [ModifierRow(locations['hair'], hair, 0)]
            if equipped:
                modifiers.append(ModifierRow(locations['accessories/glasses'], glasses, 0))
            dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[], colors=[], modifiers=modifiers)
            try:
                window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
                for _ in range(80):
                    context = window.previewContainer.context
                    if context and context.character is not None and getattr(context, 'boundingBox', None):
                        break
                    blue.synchro.SleepWallclock(100)
                if not context or not getattr(context, 'boundingBox', None):
                    raise RuntimeError('Character preview did not report bounds')
                doll = context.character.doll
                weights = doll.buildDataManager.GetMorphTargets()
                meshes = [mesh for mesh, (_, geometry, names) in doll.blendShapeMeshCache.iteritems()
                          if any(name.lower().rstrip('0123456789') == shape for name in names)]
                samples.append(dict(gender=gender, style=style, hair=hair, equipped=equipped,
                                    weight=weights.get(shape, 0), meshes=sorted(meshes)))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=samples)


result = observe()
