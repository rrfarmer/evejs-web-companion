import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    service = sm.GetService('character')
    pilots = {gender: next(char_id for char_id, info in iter_npc_characters()
                           if info.gender == gender and info.bloodlineID == 8) for gender in (0, 1)}
    rows = []
    for gender, shirt, outer in ((0, 33, None), (0, 33, 8642), (0, 308, None), (0, 308, 8642),
                                 (0, 130, None), (0, 130, 8642),
                                 (1, 28, None), (1, 81, None), (1, 101, None)):
        pilot = pilots[gender]
        dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[], colors=[], modifiers=[])
        try:
            window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
            for _ in range(80):
                context = window.previewContainer.context
                if context and getattr(context, 'boundingBox', None):
                    break
                blue.synchro.SleepWallclock(100)
            if not context or not getattr(context, 'boundingBox', None):
                raise RuntimeError('Character preview did not report bounds')
            pants, feet = (55, 157) if gender == 0 else (198, 307)
            for resource in (shirt, pants, feet, outer):
                if resource is not None:
                    service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
            context.character.Update()
            context.character.WaitForUpdate()
            manager = context.character.doll.buildDataManager
            rendered = list(context.character.visualModel.meshes)
            sleeves = []
            for modifier in manager.GetModifiersAsList(showHidden=True):
                if not modifier.respath.startswith(('dependants/sleevesupper/', 'dependants/sleeveslower/')):
                    continue
                sleeves.append(dict(path=modifier.respath, weight=modifier.weight,
                                    geometries=list(modifier.meshGeometryResPaths.values()),
                                    drawn=sum(mesh in rendered for mesh in modifier.meshes)))
            rows.append(dict(gender=gender, shirt=shirt, outer=outer, sleeves=sleeves))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=rows)


result = observe()
