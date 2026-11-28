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
    for gender, shirt, pants, feet, mode in (
        (0, 33, 55, 14733, 'default'), (0, 33, 55, 14733, 'saved'), (0, 33, 55, 14733, 'edit'),
        (0, 33, 55, 157, 'default'), (0, 33, 55, 16373, 'default'), (0, 33, 980, 14733, 'default'),
        (0, 33, 980, 14733, 'saved'), (0, 33, 8644, 14733, 'default'),
        (1, 101, 198, 3576, 'default'), (1, 101, 198, 3576, 'saved'), (1, 101, 198, 3576, 'edit'),
        (1, 101, 198, 2252, 'default')):
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
            for resource in (shirt, pants):
                if resource is not None:
                    service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
            if mode == 'saved':
                service.ApplyItemToDoll(pilot, 'dependants/boottucking', 'standard', removeFirst=True,
                                        variation='v1', doUpdate=False)
            service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(feet).resPath, doUpdate=False)
            context.character.Update()
            context.character.WaitForUpdate()
            if mode == 'edit':
                service.ApplyItemToDoll(pilot, 'dependants/boottucking', 'standard', removeFirst=True,
                                        variation='v1', doUpdate=False)
                context.character.Update()
                context.character.WaitForUpdate()
            manager = context.character.doll.buildDataManager
            rendered = list(context.character.visualModel.meshes)
            layers = []
            for modifier in manager.GetModifiersAsList(showHidden=True):
                if not modifier.respath.startswith(('dependants/boottucking/', 'dependants/bootmasks/')):
                    continue
                layers.append(dict(path=modifier.respath, weight=modifier.weight, variation=modifier.currentVariation,
                                   mask=dict(modifier.mapMask), options=modifier.GetVariations(),
                                   geometries=list(modifier.meshGeometryResPaths.values()),
                                   drawn=sum(mesh in rendered for mesh in modifier.meshes)))
            rules = sorted((name, weight) for name, weight in manager.occludeRules.items()
                           if name.startswith(('dependants/boottucking', 'dependants/bootmasks', 'utilityshapes/pantstuck', 'utilityshapes/pinchboot')))
            tuck = service.GetModifierByCategory(pilot, 'dependants/boottucking')
            rows.append(dict(gender=gender, shirt=shirt, pants=pants, feet=feet, mode=mode, layers=layers, rules=rules,
                             control=tuck.GetVariations() if tuck else [],
                             weights={name: value for name, value in manager.GetMorphTargets().items() if name.startswith(('pantstuck','pinchboot'))}))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=rows)


result = observe()
