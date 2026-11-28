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
    for gender, shirt, pants, variant in ((0,33,55,None),(0,33,55,'v1'),(0,33,8644,None),(0,33,8644,'v1'),
                                          (0,33,980,None),(0,33,1037,None),(1,101,198,None),(1,101,198,'v1'),
                                          (1,101,2237,None)):
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
            feet = 157 if gender == 0 else 307
            for resource in (shirt, feet):
                if resource is not None:
                    service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
            if variant:
                service.ApplyItemToDoll(pilot, 'dependants/waisttucking', 'standard', removeFirst=True,
                                        variation=variant, doUpdate=False)
            service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(pants).resPath, doUpdate=False)
            context.character.Update()
            context.character.WaitForUpdate()
            manager = context.character.doll.buildDataManager
            rendered = list(context.character.visualModel.meshes)
            waist = []
            for modifier in manager.GetModifiersAsList(showHidden=True):
                if not modifier.respath.startswith(('dependants/waisttucking/', 'dependants/tuck/', 'dependants/masktuck/', 'dependants/drape/')):
                    continue
                waist.append(dict(path=modifier.respath, weight=modifier.weight, variation=modifier.currentVariation, mask=dict(modifier.mapMask),
                                    options=modifier.GetVariations(),
                                    geometries=list(modifier.meshGeometryResPaths.values()),
                                    drawn=sum(mesh in rendered for mesh in modifier.meshes)))
            rules = sorted((name, weight) for name, weight in manager.occludeRules.items()
                           if name.startswith(('dependants/drape', 'dependants/tuck', 'dependants/masktuck', 'utilityshapes/')))
            rows.append(dict(gender=gender, shirt=shirt, pants=pants, variant=variant, waist=waist, rules=rules))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=rows)


result = observe()
