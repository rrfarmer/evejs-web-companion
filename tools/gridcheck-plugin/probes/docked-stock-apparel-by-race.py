import blue


def observe():
    slots = ('outer', 'topouter', 'topmiddle', 'bottomouter', 'feet', 'accessories/glasses')
    races = (1, 2, 4, 8)
    service = sm.GetService('character')
    stock = {(gender, slot): set() for gender in ('female', 'male') for slot in slots}
    for row in cfg.paperdollResources:
        if row.typeID is not None or row.resGender not in (0, 1):
            continue
        slot = row.resPath.lower().split('/types/')[0].rsplit('/', 1)[0]
        gender = 'female' if row.resGender == 0 else 'male'
        if (gender, slot) not in stock:
            continue
        path = 'res:/graphics/character/%s/paperdoll/%s' % (gender, row.resPath.lower())
        if blue.paths.exists(path):
            stock[gender, slot].add(row.paperdollResourceID)
    catalogues = {}
    for gender in ('female', 'male'):
        catalogues[gender] = {}
        for slot in slots:
            catalogues[gender][slot] = [
                sorted(asset_id for asset_id, _, _ in service.GetAvailableTypesByCategory(slot, gender, race)
                       if asset_id in stock[gender, slot])
                for race in races
            ]
    return dict(station=session.stationid, races=races, catalogues=catalogues)


result = observe()
