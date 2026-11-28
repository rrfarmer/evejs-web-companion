from types import FunctionType

import blue


def observe():
    service = sm.GetService('character')
    method = service.GetAvailableTypesByCategory.__func__
    player_choices = FunctionType(method.func_code, dict(method.func_globals, ROLE_CONTENT=0),
                                  method.func_name, method.func_defaults, method.func_closure)
    clothing = sm.GetService('cc')
    families = {'bottomouter': ('skirtmilf01', 'skirtmilf02')}
    candidates = {}
    for row in cfg.paperdollResources:
        if row.typeID is None or row.resGender not in (0, 1):
            continue
        path = row.resPath.lower()
        if '/types/' not in path:
            continue
        slot, family = path.split('/types/')[0].rsplit('/', 1)
        if family not in families.get(slot, ()):
            continue
        gender = 'female' if row.resGender == 0 else 'male'
        if blue.paths.exists('res:/graphics/character/%s/paperdoll/%s' % (gender, path)):
            candidates[row.paperdollResourceID] = row.typeID
    owned = clothing.GetMyApparel()
    rows = []
    try:
        for gender in ('female', 'male'):
            for projection in (False, True):
                clothing.availableTypeIDs = set(candidates.values()) if projection else owned
                for slot in sorted(families):
                    choices = player_choices(service, slot, gender, 2)
                    rows.append(dict(gender=gender, projected=projection, slot=slot,
                                     ids=sorted(resource for resource, _, _ in choices if resource in candidates)))
    finally:
        clothing.availableTypeIDs = owned
    from characterdata.npccharacters import iter_npc_characters
    from eve.client.script.ui.shared.preview import PreviewCharacterWnd
    from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
    from utillib import KeyVal

    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')
    garments = []
    for gender, resources in ((0, (980, 1037, 3504, 3508)),):
        pilot = next(char_id for char_id, info in iter_npc_characters()
                     if info.gender == gender and info.bloodlineID == 8)
        for resource in resources:
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
                service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(resource).resPath, doUpdate=False)
                service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(14733).resPath, doUpdate=False)
                if resource in (1037, 3508):
                    service.ApplyTypeToDoll(pilot, cfg.paperdollResources.Get(3471).resPath, doUpdate=False)
                context.character.Update()
                context.character.WaitForUpdate()
                manager = context.character.doll.buildDataManager
                garments.append(dict(id=resource, fits={name: value for name, value in manager.GetMorphTargets().iteritems()
                                       if name.startswith('pantstuck')},
                                     modifiers=[
                    dict(path=m.respath, variation=m.currentVariation,
                         geometry=list(m.meshGeometryResPaths.values()), color=dict(m.mapL),
                         zones=dict(m.mapZ), normal=dict(m.mapN),
                         meshes=[dict(name=mesh.name, effects=[area.effect.name for area in mesh.opaqueAreas
                                                              if area.effect]) for mesh in m.meshes])
                    for m in manager.GetModifiersAsList() if m.respath.startswith(('bottomouter/', 'bottominner/', 'bottommiddle/', 'dependants/bootmasks/'))]))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, owned=sorted(owned), candidates=len(candidates),
                samples=rows, garments=garments)


result = observe()
