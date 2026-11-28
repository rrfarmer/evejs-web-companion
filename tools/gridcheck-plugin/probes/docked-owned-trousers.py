from types import FunctionType

import blue


def observe():
    service = sm.GetService('character')
    method = service.GetAvailableTypesByCategory.__func__
    player_choices = FunctionType(method.func_code, dict(method.func_globals, ROLE_CONTENT=0),
                                  method.func_name, method.func_defaults, method.func_closure)
    clothing = sm.GetService('cc')
    families = {'bottomouter': ('pantsalf_01', 'pantscorpbusinessf01', 'pantsengf01', 'pantsmilf01',
                                'pantsprtf01', 'pantsslf_01', 'pantsalm01', 'pantsclm01',
                                'pantscorpbusinessm01', 'pantsengm01', 'pantsmilm01', 'pantsprtm01')}
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
    for gender, resources in ((0, (14868, 2231, 16443)), (1, (2237, 15303, 16442))):
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
                context.character.Update()
                context.character.WaitForUpdate()
                manager = context.character.doll.buildDataManager
                garments.append(dict(id=resource, modifiers=[
                    dict(path=m.respath, variation=m.currentVariation,
                         geometry=list(m.meshGeometryResPaths.values()), color=dict(m.mapL),
                         zones=dict(m.mapZ), normal=dict(m.mapN))
                    for m in manager.GetModifiersAsList() if m.respath.startswith('bottomouter/')]))
            finally:
                PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, owned=sorted(owned), candidates=len(candidates),
                samples=rows, garments=garments)


result = observe()
