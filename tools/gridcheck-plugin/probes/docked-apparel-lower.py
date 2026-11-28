import blue

FAMILIES = {
    'male': {'bottomouter': 'pantsmm01', 'feet': 'bootsmm01'},
    'female': {'bottomouter': 'pantsgf01', 'feet': 'bootsgf01'}
}


def observe():
    locations = dict((row.modifierKey, row.modifierLocationID)
                     for row in cfg.paperdollModifierLocations
                     if row.modifierKey in ('bottomouter', 'feet'))
    rows = []
    for row in cfg.paperdollResources:
        gender = 'female' if row.resGender == 0 else 'male'
        path = row.resPath.lower()
        parts = path.split('/')
        if (len(parts) != 4 or parts[2] != 'types' or
                FAMILIES[gender].get(parts[0]) != parts[1] or row.typeID is not None):
            continue
        asset = 'res:/graphics/character/%s/paperdoll/%s' % (gender, path)
        rows.append(dict(id=row.paperdollResourceID, gender=gender, path=path,
                         races=list(row.empireRestrictions or ()), exists=blue.paths.exists(asset)))
    rows.sort(key=lambda row: row['id'])
    return dict(build=3698585, station=session.stationid, locations=locations, rows=rows)


result = observe()
