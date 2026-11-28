import blue

from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    service = sm.GetService('character')
    pilot = next(char_id for char_id, info in iter_npc_characters()
                 if info.gender == 0 and info.bloodlineID == 8)
    rows = []
    for top, legs in ((None, 55), (8642, 55), (None, 8644), (8642, 8644)):
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
            for resource in (407, 33, 157, top, legs):
                if resource is not None:
                    service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
            context.character.Update()
            context.character.WaitForUpdate()
            manager = context.character.doll.buildDataManager
            active = manager.GetMorphTargets()
            meshes = []
            for modifier in manager.GetSortedModifiers():
                if not modifier.respath.startswith(('hair/', 'topinner/', 'outer/', 'bottomouter/', 'hands/', 'dependants/')):
                    continue
                for mesh in modifier.meshes:
                    resource = modifier.meshGeometryResPaths.get(mesh.name, mesh.geometryResPath)
                    if not resource:
                        continue
                    granny = blue.resMan.GetResource(resource, 'raw')
                    for _ in range(40):
                        if granny.isPrepared:
                            break
                        blue.synchro.SleepWallclock(50)
                    if not granny.isGood or granny.meshCount <= mesh.meshIndex:
                        continue
                    names = granny.GetAllMeshMorphNamesNoDigits(mesh.meshIndex)
                    weights = {name: active[name] for name in names
                               if name in active and name.startswith(('pushhairup', 'pinch', 'beltin', 'pushhem', 'pushtop', 'tightdrape'))}
                    if weights:
                        meshes.append(dict(path=modifier.respath, source=resource, index=mesh.meshIndex,
                                           weights=weights))
            rows.append(dict(top=top, legs=legs, meshes=meshes,
                             fittingRules=[(path, weight) for path, weight in sorted(manager.occludeRules.items())
                                           if path.startswith('utilityshapes/')],
                             fittingParents=[dict(path=modifier.respath, weight=modifier.weight,
                                                  parents=sorted(parent.respath for parent in manager.GetParentModifiers(modifier)))
                                             for modifier in manager.GetModifiersAsList()
                                             if modifier.respath.startswith(('utilityshapes/pinch', 'utilityshapes/pushhem',
                                                                             'utilityshapes/pushtop', 'utilityshapes/tightdrape'))],
                             weights={name: weight for name, weight in active.iteritems()
                                      if name.startswith(('pushhairup', 'pinchforearmlow', 'pinchshoulders',
                                                          'pinchchest', 'pinchbootankle', 'beltin',
                                                          'pushhemhigh', 'pushtophigh', 'tightdrape'))}))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=rows)


result = observe()
