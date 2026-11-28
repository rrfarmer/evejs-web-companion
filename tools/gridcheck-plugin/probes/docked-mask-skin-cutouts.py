import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    location = next(row.modifierLocationID for row in cfg.paperdollModifierLocations if row.modifierKey == 'accessories/masks')
    samples = []
    for gender, resources in ((0, (0, 2253, 16470)), (1, (0, 2257, 16467))):
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
                if resource:
                    row = cfg.paperdollResources.Get(resource)
                    sm.GetService('character').ApplyTypeToDoll(pilot, row.resPath, doUpdate=False)
                    context.character.Update()
                    context.character.WaitForUpdate()
                doll = context.character.doll
                masks = [dict(path=modifier.respath, maps=dict(modifier.mapMask))
                         for modifier in doll.buildDataManager.GetModifiersAsList() if '/masks/' in modifier.respath]
                surfaces = []
                for mesh in context.character.avatar.visualModel.meshes:
                    if not mesh.name.startswith('head') and 'mask' not in mesh.name.lower():
                        continue
                    for kind in ('opaqueAreas', 'decalAreas', 'transparentAreas'):
                        for area in getattr(mesh, kind):
                            effect = area.effect
                            if effect is None:
                                continue
                            values = [param.value for param in effect.parameters if param.name == 'CutMaskInfluence']
                            if values:
                                surfaces.append([mesh.name, kind, effect.name, values])
                samples.append(dict(gender=gender, resource=resource, masks=masks, surfaces=surfaces))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, location=location, samples=samples)


result = observe()
