import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    samples = []
    for gender, resources in ((0, (967, 1015, 3750, 3736)), (1, (965, 1052, 3734, 3753))):
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
                sm.GetService('character').ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
                context.character.Update()
                context.character.WaitForUpdate()
                doll = context.character.doll
                modifiers = [modifier for modifier in doll.buildDataManager.GetModifiersAsList() if '/monocle' in modifier.respath]
                weights = {name: value for name, value in doll.buildDataManager.GetMorphTargets().iteritems()
                           if 'eyepatchshape' in name or 'hidebrow' in name}
                samples.append(dict(gender=gender, resource=resource, weights=weights,
                                    geometry=[path for modifier in modifiers for path in modifier.meshGeometryResPaths.values()],
                                    effects=[area.effect.name for modifier in modifiers for mesh in modifier.meshes
                                             for area in mesh.opaqueAreas if area.effect],
                                    maps=[dict(modifier.mapD) for modifier in modifiers]))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=samples)


result = observe()
