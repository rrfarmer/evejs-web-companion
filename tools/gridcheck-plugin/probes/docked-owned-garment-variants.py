from types import FunctionType

import blue


def observe():
    service = sm.GetService('character')
    method = service.GetAvailableTypesByCategory.__func__
    player_choices = FunctionType(method.func_code, dict(method.func_globals, ROLE_CONTENT=0),
                                  method.func_name, method.func_defaults, method.func_closure)
    clothing = sm.GetService('cc')
    families = {'outer': ('robeam01',), 'topmiddle': ('shirtgm01', 'shirtgf01', 'shirtcm01', 'shirtcf01', 'tanktopm01', 'tanktopf01'),
                'accessories/glasses': ('glasses_slick_01',)}
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
    return dict(station=session.stationid, owned=sorted(owned), candidates=len(candidates), samples=rows)


result = observe()
